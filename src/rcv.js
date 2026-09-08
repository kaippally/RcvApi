import { Socket } from 'net';
import { createSocket } from 'dgram';
import { EventEmitter } from 'events';
import { XMLParser } from 'fast-xml-parser';
import { frame, decodePacket } from './osc.js';
import { MODEL_LIMITS } from './transitions.js';

const DISCOVERY_PORT = 9999;
const DISCOVERY_PAYLOAD = 'RodeBroadcast';
const DISCOVERY_TIMEOUT = 2000;
const CONNECT_TIMEOUT = 12000;
// The FTB button and the lamp code that means it is blanking the programme.
const FTB_BUTTON = 14;
const FTB_ON = 4;

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseAttributeValue: true });

// `<Thing size="dynamic"><value0><name>…</name></value0>…` — JUCE's array serialisation, used by
// <VideoInputs> and <Overlays>. Ordered by the numeric suffix, because object key order is not a
// contract; a slot with no name is an empty bank and stays an empty string.
function dynamicField(node, field) {
  if (!node || typeof node !== 'object') return [];
  return Object.keys(node)
    .filter((k) => /^value\d+$/.test(k))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .map((k) => String(node[k]?.[field] ?? '').trim());
}

const dynamicNames = (node) => dynamicField(node, 'name');

/** Bit 0 = index 1. */
function maskToIndices(mask) {
  const out = [];
  for (let bit = 0; bit < 32; bit++) if (mask & (1 << bit)) out.push(bit + 1);
  return out;
}

export class RcvClient extends EventEmitter {
  constructor({ ip, port = 10024, reconnectInterval = 10000, refreshInterval = 10000, showInterval = 30000 }) {
    super();
    this.ip = ip;
    this.port = port;
    this.reconnectInterval = reconnectInterval;
    this.refreshInterval = refreshInterval;
    this.showInterval = showInterval;

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.intentional = false;
    this.lastError = null;
    this.reconnectTimer = null;
    this.refreshTimer = null;
    this.showTimer = null;
    this.connectTimer = null;

    // The last raw <RcvShow> XML the device sent, and when. This is the only complete record of
    // the operator's show that leaves the device, so it is kept verbatim rather than only parsed.
    this.lastShowXml = null;
    this.lastShowAt = null;
    // When the device last said anything at all. `connected` is only a TCP fact — a socket that
    // is up but silent is what a dropped remote-control mode looks like from here.
    this.lastRxAt = null;

    this.device = { model: null, modelName: 'Unknown', name: null, serialNo: null, swVersion: null };
    this.state = {
      showName: null,
      transition: null,
      transitionCategory: null,
      transitionTimeMs: null,
      invertWipe: null,
      switchingMode: null,
      frameRate: null,
      program: null,
      preview: null,
      streaming: null,
      recording: null,
      scenes: [],
      // Bank names as the operator set them on the device. Only <Scenes> rides the push
      // channel; these three come from the show dump, which is why it is re-requested.
      inputs: [],
      /**
       * What is physically behind each input, from the show dump's `<VideoInputs><type>`:
       * 'hdmi 1'..'hdmi 3' for a wired socket, 'none' for a bank the operator named but never
       * gave a source.
       *
       * An input with 'none' CANNOT be put on programme. The desk accepts `/device/input N`
       * and then does nothing at all — pgmcurrent never moves, so nothing downstream can tell
       * the press apart from one that never happened. Reported here because it is the only
       * warning any consumer can get before wiring a button that will never fire.
       */
      inputSources: [],
      media: [],
      overlays: [],
      /** 1-based indices of the overlays currently on program (from the PgmOverlay bitmask). */
      programOverlays: [],
      /**
       * Fade to black — the desk's own blank button, lit or not.
       *
       * It is invisible everywhere else: blanking does not move `pgmcurrent`, does not touch a
       * show attribute and writes nothing to the show dump, so the ONLY report of it is the
       * button's own lamp: `/device/buttons/14/colour 4` when the programme goes black, `3`
       * when it comes back, with nothing else on the wire (measured on an RCV S, firmware
       * 1.3.05). The lamp LATCHES — 4 stands for as long as the desk is blanking, it is not a
       * press/release pulse — so a poller sampling this a few times a second cannot miss it.
       * Button 14 is FTB on every model — the same index RØDE's own Companion module drives.
       */
      ftb: false,
    };
  }

  get studioMode() {
    return this.state.switchingMode === 'studioLeft';
  }

  get limits() {
    return MODEL_LIMITS[this.device.model] ?? MODEL_LIMITS[1];
  }

  connect() {
    if (this.socket) this.destroySocket();
    this.intentional = false;

    const socket = new Socket();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);

    this.connectTimer = setTimeout(() => {
      this.lastError = { message: 'connect ETIMEDOUT ' + this.ip + ':' + this.port, at: new Date().toISOString() };
      socket.destroy();
    }, CONNECT_TIMEOUT);

    socket.on('data', (chunk) => this.onData(chunk));

    socket.on('error', (err) => {
      this.lastError = { message: err.message, code: err.code ?? null, at: new Date().toISOString() };
      this.emit('log', 'socket error: ' + err.message);
    });

    socket.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      clearTimeout(this.connectTimer);
      clearInterval(this.refreshTimer);
      clearInterval(this.showTimer);
      if (wasConnected) this.emit('log', 'connection closed');
      if (!this.intentional) this.scheduleReconnect();
    });

    socket.connect(this.port, this.ip, () => {
      clearTimeout(this.connectTimer);
      this.connected = true;
      this.lastError = null;
      this.emit('log', 'connected to ' + this.ip + ':' + this.port);

      // /remote puts the device into remote-control mode and starts the state push;
      // /show pulls the full XML show dump we hydrate transition state from.
      this.send('/show');
      this.send('/remote');
      this.send('/device/refresh');
      this.send('/device');

      this.refreshTimer = setInterval(() => {
        if (!this.connected) return;
        // Re-arm remote-control mode on every tick. The device drops it whenever its show is
        // reloaded, reset or taken over by RØDE Central, and it does NOT close the socket when
        // it does — so without this the push channel dies silently while `connected` stays true,
        // pgm/pvw freeze on their last value and every trigger stops firing. /remote is
        // idempotent (verified on hardware), so re-sending it costs nothing.
        this.send('/remote');
        this.send('/device/refresh');
        this.send('/device');
      }, this.refreshInterval);

      // Input, media and overlay names only exist in the show dump — the device never pushes
      // them the way it pushes a scene rename — so re-pull it on a slow timer to notice edits.
      this.showTimer = setInterval(() => {
        if (!this.connected) return;
        this.send('/show');
      }, this.showInterval);

      this.discover().catch(() => {});
    });
  }

  disconnect() {
    this.intentional = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.destroySocket();
    this.connected = false;
  }

  destroySocket() {
    clearTimeout(this.connectTimer);
    clearInterval(this.refreshTimer);
    clearInterval(this.showTimer);
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.intentional) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectInterval);
  }

  send(address, ...args) {
    if (!this.connected || !this.socket) {
      throw Object.assign(new Error('RCV is not connected'), { status: 503 });
    }
    this.socket.write(frame(address, args));
    this.emit('log', '-> ' + address + ' ' + JSON.stringify(args));
  }

  onData(chunk) {
    this.lastRxAt = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      if (length <= 0) {
        this.buffer = this.buffer.subarray(4);
        continue;
      }
      if (this.buffer.length < length + 4) break;

      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);

      try {
        for (const msg of decodePacket(body)) this.handle(msg.address, msg.args);
      } catch {
        // malformed packet: drop it, framing has already advanced
      }
    }
  }

  handle(address, args) {
    if (address === '/show') return this.hydrateFromShow(args[0]);
    if (address === '/meters/values') return;

    const first = args[0];

    // Live scene rename: /show/scene/<1-based id>/name
    const sceneName = address.match(/^\/show\/scene\/(\d+)\/name$/);
    if (sceneName) {
      this.state.scenes[Number(sceneName[1]) - 1] = String(first ?? '');
      this.emit('message', { address, args });
      return;
    }

    switch (address) {
      case '/show/name':
        this.state.showName = String(first);
        break;
      case '/show/transition':
        this.state.transitionCategory = String(first);
        if (String(first) === 'fade') this.state.transition = 'fade';
        break;
      case '/show/transition_data': {
        // A FADE HAS NO VARIANT, and the device says so by pushing `none` here. Taking that
        // literally overwrote the id we had just derived from the category, so a desk sitting on
        // Fade reported `transition: "none"` for ever — while `transitionCategory` still read
        // `fade`, one field disagreeing with the other. It reads as "this desk has no transition
        // set", which is a lie that sends whoever believes it looking for the wrong fault
        // entirely. The XML hydration path below already guards this; the live handler did not.
        const data = String(first);
        if (data && data !== 'none') this.state.transition = data;
        else if (this.state.transitionCategory) this.state.transition = this.state.transitionCategory;
        break;
      }
      case '/show/transition_time':
        this.state.transitionTimeMs = Number(first);
        break;
      case '/show/invert_wipe':
        this.state.invertWipe = Boolean(Number(first));
        break;
      case '/show/switchingMode':
        this.state.switchingMode = String(first);
        break;
      case '/show/frameRate':
        this.state.frameRate = Number(first);
        break;
      case '/show/liveEnabled':
        this.state.streaming = Boolean(Number(first));
        break;
      case '/show/recordEnabled':
        this.state.recording = Boolean(Number(first));
        break;
      case '/show/pgmcurrent':
        this.state.program = { type: String(first), index: Number(args[1]) };
        break;
      case '/show/pvwcurrent':
        this.state.preview = { type: String(first), index: Number(args[1]) };
        break;
      // 4 = blanking, 3 = not. Every other code is a bank state that cannot apply to a button
      // with nothing behind it.
      case `/device/buttons/${FTB_BUTTON}/colour`:
        this.state.ftb = Number(first) === FTB_ON;
        break;
    }

    this.emit('message', { address, args });
  }

  hydrateFromShow(payload) {
    const raw = payload.toString();
    let parsed;
    try {
      parsed = xml.parse(raw);
    } catch {
      return;
    }
    const show = parsed?.RcvShow;
    if (!show) return;

    // Hold the dump verbatim before parsing anything out of it. The device is the only copy of
    // a show, and a factory reset or a bad firmware update takes it with no warning — this is
    // what makes the names, banks and transition set recoverable afterwards.
    this.lastShowXml = raw;
    this.lastShowAt = Date.now();
    this.emit('show', raw);

    if (show['@_name'] !== undefined) this.state.showName = show['@_name'];
    if (show['@_switching_mode'] !== undefined) this.state.switchingMode = show['@_switching_mode'];
    if (show['@_frameRate'] !== undefined) this.state.frameRate = Number(show['@_frameRate']);
    if (show['@_transition_time'] !== undefined) this.state.transitionTimeMs = parseFloat(show['@_transition_time']);
    if (show['@_invert_wipe'] !== undefined) this.state.invertWipe = Boolean(show['@_invert_wipe']);

    const category = show['@_transition'];
    const data = show['@_transition_data'];
    if (category !== undefined) this.state.transitionCategory = category;

    // Fade carries no variant, so its category IS the transition; every other
    // transition reports its variant in transition_data. The device spells "no variant" as the
    // STRING `none`, which this guard let through — so a desk sitting on Fade hydrated as
    // `transition: "none"` and read as a desk with no transition at all.
    if (data !== undefined && data !== null && data !== '' && data !== 'none') this.state.transition = data;
    else if (category !== undefined) this.state.transition = category;

    // A single <Scene/> parses to an object rather than an array.
    const scenes = show.Scenes?.Scene;
    if (scenes) {
      const list = Array.isArray(scenes) ? scenes : [scenes];
      this.state.scenes = list.map((s) => String(s?.['@_name'] ?? ''));
    }

    // The other three banks are named in the show dump too, each in its own shape:
    // <VideoInputs>/<Overlays> are `size="dynamic"` containers of <valueN><name/>, while
    // <MediaFiles> is a list of <File name="…"/>. An empty name = an unassigned slot.
    this.state.inputs = dynamicNames(show.VideoInputs);
    this.state.inputSources = dynamicField(show.VideoInputs, 'type');
    this.state.overlays = dynamicNames(show.Overlays);
    const files = show.MediaFiles?.File;
    if (files) {
      const list = Array.isArray(files) ? files : [files];
      this.state.media = list.map((f) => String(f?.['@_name'] ?? '').trim());
    }

    // PgmOverlay is a bitmask of the overlays on program; 0xFFFFFFFF is "unset", not "all on".
    const mask = Number(show['@_PgmOverlay']);
    this.state.programOverlays = Number.isInteger(mask) && mask !== 0xFFFFFFFF ? maskToIndices(mask) : [];

    this.emit('log', 'show state hydrated');
  }

  // Unicast UDP identity probe; the device answers with an <RcvDevice/> XML doc.
  discover() {
    return new Promise((resolve) => {
      const client = createSocket('udp4');
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        try {
          client.close();
        } catch {
          // already closed
        }
        resolve(result);
      };

      client.on('message', (msg) => {
        try {
          const dev = xml.parse(msg.toString())?.RcvDevice;
          if (!dev?.['@_name']) return;
          const model = Number(dev['@_device_model']);
          this.device = {
            model,
            modelName: MODEL_LIMITS[model]?.name ?? 'Unknown',
            name: dev['@_name'],
            serialNo: dev['@_serial_no'],
            swVersion: dev['@_sw_version'],
          };
          finish(this.device);
        } catch {
          // not an RcvDevice response
        }
      });

      client.on('error', () => finish(null));

      client.bind(0, '0.0.0.0', () => {
        client.send(Buffer.from(DISCOVERY_PAYLOAD), DISCOVERY_PORT, this.ip, (err) => {
          if (err) return finish(null);
          setTimeout(() => finish(null), DISCOVERY_TIMEOUT);
        });
      });
    });
  }

  status() {
    return {
      connected: this.connected,
      target: { ip: this.ip, port: this.port },
      device: this.device,
      limits: this.limits,
      studioMode: this.studioMode,
      state: this.state,
      // A socket can be up and the device still deaf, so say when it last spoke. `stale` means
      // two refresh ticks have passed with nothing coming back — the link is nominally connected
      // but the state below is frozen and should not be trusted.
      link: {
        lastRxAt: this.lastRxAt ? new Date(this.lastRxAt).toISOString() : null,
        lastShowAt: this.lastShowAt ? new Date(this.lastShowAt).toISOString() : null,
        stale: this.connected && this.lastRxAt != null && Date.now() - this.lastRxAt > this.refreshInterval * 2,
      },
      lastError: this.lastError,
    };
  }
}
