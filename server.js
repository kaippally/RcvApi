import express from 'express';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { RcvClient } from './src/rcv.js';
import { ShowStore } from './src/showStore.js';
import { TRANSITIONS, MAX_TRANSITION_MS } from './src/transitions.js';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), 'public')));

const PORT = Number(process.env.PORT || 4017);
const RCV_IP = process.env.RCV_IP || '192.168.0.0';
const RCV_PORT = Number(process.env.RCV_PORT || 10024);
const AUTO_CONNECT = String(process.env.AUTO_CONNECT || 'true') === 'true';

const rcv = new RcvClient({
  ip: RCV_IP,
  port: RCV_PORT,
  reconnectInterval: Number(process.env.RECONNECT_INTERVAL || 10000),
  refreshInterval: Number(process.env.REFRESH_INTERVAL || 10000),
});

rcv.on('log', (msg) => console.log('[RCV] ' + msg));

const shows = new ShowStore(join(dirname(fileURLToPath(import.meta.url)), 'data', 'shows'));
rcv.on('show', (xmlText) => {
  const file = shows.archive(xmlText);
  if (file) console.log('[RCV] show changed — archived ' + file);
});

const SOURCE_ADDRESSES = { input: '/device/input', scene: '/device/scene', media: '/device/media' };
const BUTTON_AUTO = 106;
const BUTTON_CUT = 105;
const FTB_BUTTON = 14;

function fail(res, status, message) {
  res.status(status).json({ ok: false, error: message });
  return null;
}

function requireConnected(res) {
  if (!rcv.connected) {
    fail(res, 503, 'RCV is not connected at ' + rcv.ip + ':' + rcv.port);
    return false;
  }
  return true;
}

function validateSource(res, source) {
  if (!source || typeof source !== 'object') return fail(res, 400, 'source must be an object');
  const address = SOURCE_ADDRESSES[source.type];
  if (!address) return fail(res, 400, 'source.type must be one of: input, scene, media');

  const index = Number(source.index);
  const max = rcv.limits[source.type === 'input' ? 'inputs' : source.type === 'scene' ? 'scenes' : 'media'];
  if (!Number.isInteger(index) || index < 1 || index > max) {
    return fail(res, 400, 'source.index must be an integer 1-' + max + ' on the ' + rcv.limits.name);
  }
  return { address, index };
}

// Every setter updates local state optimistically. The device echoes the change
// back a moment later and corrects us, but callers (and /transition/run, which
// branches on switching mode) must not read stale state within the same request.
function applyTransition(type) {
  const transition = TRANSITIONS[type];
  rcv.send('/show/transition', transition.category);
  // Dip and every wipe need the variant sent as a second message; fade has none.
  if (transition.data) rcv.send('/show/transition_data', transition.data);
  rcv.state.transitionCategory = transition.category;
  rcv.state.transition = type;
}

// transition_time goes on the wire as an OSC string of milliseconds, not an int.
function applyTime(ms) {
  const rounded = Math.round(ms);
  rcv.send('/show/transition_time', String(rounded));
  rcv.state.transitionTimeMs = rounded;
}

function applyMirror(enabled) {
  rcv.send('/show/invert_wipe', enabled ? 1 : 0);
  rcv.state.invertWipe = Boolean(enabled);
}

function applySwitchingMode(mode) {
  rcv.send('/show/switchingMode', mode);
  rcv.state.switchingMode = mode;
}

const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'RCV API',
      version: '1.0.0',
      description:
        'REST relay for RØDECaster Video scene transitions. Speaks OSC over TCP:10024 to the device; ' +
        'no OBS, no StudioMate dependency. Configure the target in this project’s own .env.',
    },
    servers: [{ url: 'http://localhost:' + PORT }],
  },
  apis: ['./server.js'],
});

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(spec));

/**
 * @openapi
 * /api/health:
 *   get:
 *     summary: Liveness plus connection state
 *     responses:
 *       200: { description: OK }
 */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'rcv-api', connected: rcv.connected });
});

/**
 * @openapi
 * /api/rcv/status:
 *   get:
 *     summary: Full device, connection and transition state
 *     responses:
 *       200: { description: OK }
 */
app.get('/api/rcv/status', (_req, res) => {
  res.json({ ok: true, ...rcv.status() });
});

/**
 * @openapi
 * /api/rcv/probe:
 *   post:
 *     summary: Re-arm remote mode and wait for the device to answer — the deaf-link check and its fix
 *     responses:
 *       200: { description: Probe ran; `answered` says whether the device replied }
 *       503: { description: Not connected }
 */
// A socket that is open proves nothing about whether the device is still listening: it drops
// remote-control mode on a show reload or reset without closing the connection, after which the
// pushed state — and only the pushed state — stops arriving. This asks the question directly.
// It re-sends /remote (the re-arm, which is the fix for that case), then /show and /device, and
// waits for anything to come back. `answered:false` means the switcher is genuinely deaf and the
// socket needs rebuilding; `answered:true` means the link is live as of right now.
app.post('/api/rcv/probe', async (_req, res) => {
  if (!requireConnected(res)) return;

  const before = rcv.lastRxAt;
  rcv.send('/remote');
  rcv.send('/device/refresh');
  rcv.send('/device');
  rcv.send('/show');

  const deadline = Date.now() + 3000;
  while (rcv.lastRxAt === before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const answered = rcv.lastRxAt !== before;
  res.json({
    ok: true,
    answered,
    waitedMs: answered ? 3000 - (deadline - Date.now()) : 3000,
    lastRxAt: rcv.lastRxAt ? new Date(rcv.lastRxAt).toISOString() : null,
    program: rcv.state.program,
  });
});

/**
 * @openapi
 * /api/rcv/show:
 *   get:
 *     summary: The live show dump as the device last sent it (raw XML)
 *     responses:
 *       200: { description: OK }
 *       503: { description: No show dump received yet }
 */
app.get('/api/rcv/show', (_req, res) => {
  if (!rcv.lastShowXml) return fail(res, 503, 'no show dump received yet');
  res.type('application/xml').send(rcv.lastShowXml);
});

/**
 * @openapi
 * /api/rcv/show/backups:
 *   get:
 *     summary: Archived show snapshots, newest first — one per real change
 *     responses:
 *       200: { description: OK }
 */
app.get('/api/rcv/show/backups', (_req, res) => {
  res.json({ ok: true, dir: shows.dir, backups: shows.list() });
});

/**
 * @openapi
 * /api/rcv/show/backups/{file}:
 *   get:
 *     summary: One archived snapshot, as XML
 *     parameters:
 *       - in: path
 *         name: file
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: OK }
 *       404: { description: No such snapshot }
 */
app.get('/api/rcv/show/backups/:file', (req, res) => {
  const body = shows.read(req.params.file);
  if (body == null) return fail(res, 404, 'no such snapshot');
  res.type('application/xml').send(body);
});

/**
 * @openapi
 * /api/rcv/connect:
 *   post:
 *     summary: Connect (or reconnect) to the device
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ip: { type: string, description: Override the .env target for this session }
 *     responses:
 *       200: { description: Connection attempt started }
 */
app.post('/api/rcv/connect', (req, res) => {
  if (req.body?.ip) rcv.ip = String(req.body.ip);
  rcv.connect();
  res.json({ ok: true, target: { ip: rcv.ip, port: rcv.port } });
});

/**
 * @openapi
 * /api/rcv/disconnect:
 *   post:
 *     summary: Close the connection and stop reconnecting
 *     responses:
 *       200: { description: Disconnected }
 */
app.post('/api/rcv/disconnect', (_req, res) => {
  rcv.disconnect();
  res.json({ ok: true, connected: false });
});

/**
 * @openapi
 * /api/rcv/transitions:
 *   get:
 *     summary: Catalog of every transition the device accepts
 *     responses:
 *       200: { description: OK }
 */
app.get('/api/rcv/transitions', (_req, res) => {
  res.json({
    ok: true,
    maxTimeMs: MAX_TRANSITION_MS,
    transitions: Object.entries(TRANSITIONS).map(([id, t]) => ({ id, ...t })),
  });
});

/**
 * @openapi
 * /api/rcv/scenes:
 *   get:
 *     summary: Scene bank names with their on-air state
 *     responses:
 *       200: { description: OK }
 */
app.get('/api/rcv/scenes', (_req, res) => {
  const { program, preview, scenes } = rcv.state;
  const list = [];

  for (let index = 1; index <= rcv.limits.scenes; index++) {
    const name = scenes[index - 1] ?? '';
    list.push({
      index,
      name,
      assigned: name !== '',
      live: program?.type === 'scene' && program.index === index,
      preview: preview?.type === 'scene' && preview.index === index,
    });
  }

  res.json({ ok: true, scenes: list });
});

/**
 * @openapi
 * /api/rcv/transition:
 *   get:
 *     summary: Current transition, duration, mirror flag and switching mode
 *     responses:
 *       200: { description: OK }
 *   put:
 *     summary: Set the active transition (optionally its duration and mirror flag)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type]
 *             properties:
 *               type: { type: string, example: box_tl, description: An id from /api/rcv/transitions }
 *               timeMs: { type: integer, example: 500, description: 0-60000 }
 *               mirror: { type: boolean, description: Reverse the wipe direction }
 *     responses:
 *       200: { description: Applied }
 *       400: { description: Unknown transition or out-of-range duration }
 *       503: { description: Not connected }
 */
app.get('/api/rcv/transition', (_req, res) => {
  const { transition, transitionCategory, transitionTimeMs, invertWipe, switchingMode } = rcv.state;
  res.json({
    ok: true,
    transition,
    category: transitionCategory,
    title: TRANSITIONS[transition]?.title ?? null,
    timeMs: transitionTimeMs,
    mirror: invertWipe,
    switchingMode,
  });
});

app.put('/api/rcv/transition', (req, res) => {
  const { type, timeMs, mirror } = req.body ?? {};

  if (!TRANSITIONS[type]) {
    return fail(res, 400, 'Unknown transition "' + type + '". See GET /api/rcv/transitions');
  }
  if (timeMs !== undefined && (!Number.isFinite(Number(timeMs)) || timeMs < 0 || timeMs > MAX_TRANSITION_MS)) {
    return fail(res, 400, 'timeMs must be 0-' + MAX_TRANSITION_MS);
  }
  if (!requireConnected(res)) return;

  applyTransition(type);
  if (timeMs !== undefined) applyTime(Number(timeMs));
  if (mirror !== undefined) applyMirror(mirror);

  res.json({ ok: true, transition: type, timeMs: timeMs ?? rcv.state.transitionTimeMs, mirror });
});

/**
 * @openapi
 * /api/rcv/transition/time:
 *   put:
 *     summary: Set the transition duration
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ms]
 *             properties:
 *               ms: { type: integer, example: 500 }
 *     responses:
 *       200: { description: Applied }
 */
app.put('/api/rcv/transition/time', (req, res) => {
  const ms = Number(req.body?.ms);
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_TRANSITION_MS) {
    return fail(res, 400, 'ms must be 0-' + MAX_TRANSITION_MS);
  }
  if (!requireConnected(res)) return;

  applyTime(ms);
  res.json({ ok: true, timeMs: Math.round(ms) });
});

/**
 * @openapi
 * /api/rcv/transition/mirror:
 *   put:
 *     summary: Reverse the direction of the active wipe
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [enabled]
 *             properties:
 *               enabled: { type: boolean }
 *     responses:
 *       200: { description: Applied }
 */
app.put('/api/rcv/transition/mirror', (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return fail(res, 400, 'enabled must be a boolean');
  if (!requireConnected(res)) return;

  applyMirror(enabled);
  res.json({ ok: true, mirror: enabled });
});

/**
 * @openapi
 * /api/rcv/switching-mode:
 *   put:
 *     summary: Switch between instant (cut on select) and studio (preview then take) modes
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mode]
 *             properties:
 *               mode: { type: string, enum: [instant, studioLeft, toggle] }
 *     responses:
 *       200: { description: Applied }
 */
app.put('/api/rcv/switching-mode', (req, res) => {
  let mode = req.body?.mode;
  if (!['instant', 'studioLeft', 'toggle'].includes(mode)) {
    return fail(res, 400, 'mode must be instant, studioLeft or toggle');
  }
  if (!requireConnected(res)) return;

  if (mode === 'toggle') mode = rcv.studioMode ? 'instant' : 'studioLeft';
  applySwitchingMode(mode);
  res.json({ ok: true, mode });
});

/**
 * @openapi
 * /api/rcv/source:
 *   post:
 *     summary: Select a source
 *     description: >
 *       In studio mode this loads the source into preview. In instant mode the device
 *       switches to it immediately, performing the active transition.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, index]
 *             properties:
 *               type: { type: string, enum: [input, scene, media] }
 *               index: { type: integer, example: 1 }
 *     responses:
 *       200: { description: Selected }
 */
app.post('/api/rcv/source', (req, res) => {
  const source = validateSource(res, req.body);
  if (!source) return;
  if (!requireConnected(res)) return;

  rcv.send(source.address, source.index);
  res.json({
    ok: true,
    selected: { type: req.body.type, index: source.index },
    target: rcv.studioMode ? 'preview' : 'program',
  });
});

/**
 * @openapi
 * /api/rcv/ftb:
 *   post:
 *     summary: Press the desk's Fade to Black button
 *     description: >
 *       Blanks the programme output and fades the audio with it — the same press as the
 *       button on the front panel, and a toggle in the same way: pressing again brings the
 *       picture back. Sent as the button-14 pair (0 then 1) that RØDE's own control app
 *       sends; the lamp comes back on `/device/buttons/14/colour` and is reported as
 *       `state.ftb`.
 *     responses:
 *       200: { description: Pressed }
 */
app.post('/api/rcv/ftb', (req, res) => {
  if (!requireConnected(res)) return;
  // Down then up: FTB is the one button the desk wants as a pair rather than a single 1.
  rcv.send('/device/button', FTB_BUTTON, 0);
  rcv.send('/device/button', FTB_BUTTON, 1);
  res.json({ ok: true, pressed: 'ftb' });
});

/**
 * @openapi
 * /api/rcv/overlay:
 *   post:
 *     summary: Toggle an overlay bank on or off air
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [index]
 *             properties:
 *               index: { type: integer, example: 1 }
 *     responses:
 *       200: { description: Toggled }
 */
app.post('/api/rcv/overlay', (req, res) => {
  const index = Number(req.body?.index);
  if (!Number.isInteger(index) || index < 1 || index > rcv.limits.overlays) {
    return fail(res, 400, 'index must be an integer 1-' + rcv.limits.overlays);
  }
  if (!requireConnected(res)) return;

  rcv.send('/device/toggleOverlay', index);
  res.json({ ok: true, overlay: index });
});

/**
 * @openapi
 * /api/rcv/overlay/clear-source:
 *   post:
 *     summary: Take off air every overlay that keys the given source
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [source]
 *             properties:
 *               source: { type: string, example: 'input:3' }
 *     responses:
 *       200: { description: "`hidden` lists the overlays taken down" }
 */
// The desk only toggles, so an overlay is sent the toggle only when a show dump fetched just now
// says it is on — a stale PgmOverlay would turn a hidden one back ON.
app.post('/api/rcv/overlay/clear-source', async (req, res) => {
  const source = String(req.body?.source ?? '');
  if (!/^[a-z]+:\d+$/i.test(source)) return fail(res, 400, 'source must look like input:3');
  if (!requireConnected(res)) return;

  if (!(await rcv.refreshShow())) return fail(res, 504, 'the switcher did not return its show');
  const { overlaySources, programOverlays, overlays } = rcv.state;
  const hidden = programOverlays
    .filter((i) => overlaySources[i - 1] === source)
    .map((i) => ({ index: i, name: overlays[i - 1] || `Overlay ${i}` }));
  for (const o of hidden) rcv.send('/device/toggleOverlay', o.index);
  if (hidden.length) void rcv.refreshShow();
  res.json({ ok: true, source, hidden });
});

/**
 * @openapi
 * /api/rcv/take:
 *   post:
 *     summary: Perform the transition (AUTO) or a hard cut (CUT)
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mode: { type: string, enum: [auto, cut], default: auto }
 *     responses:
 *       200: { description: Taken }
 */
app.post('/api/rcv/take', (req, res) => {
  const mode = req.body?.mode ?? 'auto';
  if (!['auto', 'cut'].includes(mode)) return fail(res, 400, 'mode must be auto or cut');
  if (!requireConnected(res)) return;

  rcv.send('/device/button', mode === 'auto' ? BUTTON_AUTO : BUTTON_CUT, 1);
  res.json({ ok: true, mode });
});

/**
 * @openapi
 * /api/rcv/transition/run:
 *   post:
 *     summary: One-shot transition — set type/duration/mirror, select the source, then take
 *     description: >
 *       In studio mode the source is loaded to preview and the take is then performed.
 *       In instant mode selecting the source already performs the transition, so the
 *       take is skipped and the response says so.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type: { type: string, example: leftright }
 *               timeMs: { type: integer, example: 750 }
 *               mirror: { type: boolean }
 *               source:
 *                 type: object
 *                 properties:
 *                   type: { type: string, enum: [input, scene, media] }
 *                   index: { type: integer }
 *               take: { type: string, enum: [auto, cut], default: auto }
 *     responses:
 *       200: { description: Ran }
 */
app.post('/api/rcv/transition/run', (req, res) => {
  const { type, timeMs, mirror, source, take = 'auto' } = req.body ?? {};

  if (type !== undefined && !TRANSITIONS[type]) {
    return fail(res, 400, 'Unknown transition "' + type + '". See GET /api/rcv/transitions');
  }
  if (timeMs !== undefined && (!Number.isFinite(Number(timeMs)) || timeMs < 0 || timeMs > MAX_TRANSITION_MS)) {
    return fail(res, 400, 'timeMs must be 0-' + MAX_TRANSITION_MS);
  }
  if (!['auto', 'cut'].includes(take)) return fail(res, 400, 'take must be auto or cut');

  let resolved = null;
  if (source !== undefined) {
    resolved = validateSource(res, source);
    if (!resolved) return;
  }
  if (!requireConnected(res)) return;

  const steps = [];

  if (type !== undefined) {
    applyTransition(type);
    steps.push('transition=' + type);
  }
  if (timeMs !== undefined) {
    applyTime(Number(timeMs));
    steps.push('timeMs=' + Math.round(Number(timeMs)));
  }
  if (mirror !== undefined) {
    applyMirror(mirror);
    steps.push('mirror=' + Boolean(mirror));
  }

  let took = false;
  if (resolved) {
    rcv.send(resolved.address, resolved.index);
    steps.push('source=' + source.type + ':' + resolved.index);

    if (rcv.studioMode) {
      rcv.send('/device/button', take === 'auto' ? BUTTON_AUTO : BUTTON_CUT, 1);
      steps.push('take=' + take);
      took = true;
    }
  } else {
    rcv.send('/device/button', take === 'auto' ? BUTTON_AUTO : BUTTON_CUT, 1);
    steps.push('take=' + take);
    took = true;
  }

  res.json({
    ok: true,
    steps,
    took,
    note: resolved && !took ? 'Instant mode: selecting the source performed the transition; no take sent.' : undefined,
  });
});

/**
 * @openapi
 * /api/rcv/raw:
 *   post:
 *     summary: Escape hatch — send an arbitrary OSC message to the device
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address]
 *             properties:
 *               address: { type: string, example: /show/logoEnable }
 *               args: { type: array, items: {}, example: [1] }
 *     responses:
 *       200: { description: Sent }
 */
app.post('/api/rcv/raw', (req, res) => {
  const address = req.body?.address;
  const args = req.body?.args ?? [];
  if (typeof address !== 'string' || !address.startsWith('/')) {
    return fail(res, 400, 'address must be an OSC path starting with /');
  }
  if (!Array.isArray(args)) return fail(res, 400, 'args must be an array');
  if (!requireConnected(res)) return;

  rcv.send(address, ...args);
  res.json({ ok: true, address, args });
});

app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ ok: false, error: err.message });
});

app.listen(PORT, () => {
  console.log('[rcv-api] listening on http://localhost:' + PORT);
  console.log('[rcv-api] docs at http://localhost:' + PORT + '/api-docs');
  if (AUTO_CONNECT) rcv.connect();
  else console.log('[rcv-api] AUTO_CONNECT is off — POST /api/rcv/connect to start');
});
