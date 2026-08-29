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

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseAttributeValue: true });

export class RcvClient extends EventEmitter {
  constructor({ ip, port = 10024, reconnectInterval = 10000, refreshInterval = 10000 }) {
    super();
    this.ip = ip;
    this.port = port;
    this.reconnectInterval = reconnectInterval;
    this.refreshInterval = refreshInterval;

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.intentional = false;
    this.lastError = null;
    this.reconnectTimer = null;
    this.refreshTimer = null;
    this.connectTimer = null;

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
        this.send('/device/refresh');
        this.send('/device');
      }, this.refreshInterval);

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
      case '/show/transition_data':
        this.state.transition = String(first);
        break;
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
    }

    this.emit('message', { address, args });
  }

  hydrateFromShow(payload) {
    let parsed;
    try {
      parsed = xml.parse(payload.toString());
    } catch {
      return;
    }
    const show = parsed?.RcvShow;
    if (!show) return;

    if (show['@_name'] !== undefined) this.state.showName = show['@_name'];
    if (show['@_switching_mode'] !== undefined) this.state.switchingMode = show['@_switching_mode'];
    if (show['@_frameRate'] !== undefined) this.state.frameRate = Number(show['@_frameRate']);
    if (show['@_transition_time'] !== undefined) this.state.transitionTimeMs = parseFloat(show['@_transition_time']);
    if (show['@_invert_wipe'] !== undefined) this.state.invertWipe = Boolean(show['@_invert_wipe']);

    const category = show['@_transition'];
    const data = show['@_transition_data'];
    if (category !== undefined) this.state.transitionCategory = category;

    // Fade carries no variant, so its category IS the transition; every other
    // transition reports its variant in transition_data.
    if (data !== undefined && data !== null && data !== '') this.state.transition = data;
    else if (category !== undefined) this.state.transition = category;

    // A single <Scene/> parses to an object rather than an array.
    const scenes = show.Scenes?.Scene;
    if (scenes) {
      const list = Array.isArray(scenes) ? scenes : [scenes];
      this.state.scenes = list.map((s) => String(s?.['@_name'] ?? ''));
    }

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
      lastError: this.lastError,
    };
  }
}
