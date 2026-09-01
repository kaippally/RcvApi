# RCV API

Standalone REST relay for **RØDECaster Video** scene transitions. Isolated like the
sibling `ObsApi` / `YoloboxApi` projects: own `package.json`, own `.env`, own PM2
process. Nothing here imports from StudioMate, and StudioMate does not need to know
it exists.

## Protocol

The device speaks **OSC over TCP on port 10024**. Each packet is wrapped in a
4-byte **little-endian** length prefix; the OSC payload inside is standard
big-endian OSC. There is no authentication — anything on the LAN that can reach
port 10024 can drive the switcher.

On connect the service sends `/show` (full XML show dump, used to hydrate state)
and `/remote` (puts the device into remote-control mode so it pushes state back on
the same socket), then re-polls `/device/refresh` + `/device` every 10 s.

Device identity (model, serial, firmware) comes from a **UDP unicast to port 9999**
with the ASCII payload `RodeBroadcast`; the device replies with an `<RcvDevice/>`
XML document.

## Setup

```powershell
cd C:\KC_Assets\rodecastervideo
npm install
# set RCV_IP in .env to the switcher's LAN address
.\start.ps1
```

Web interface: <http://localhost:4017/>
Swagger UI: <http://localhost:4017/api-docs>

## Web interface

Four scene buttons showing the live scene names pulled off the device, with **PGM**
(red) and **PVW** (green) state, plus the transition picker, duration, mirror,
switching mode and CUT/AUTO. Served straight off this API — open it on any
tablet or second screen on the LAN at `http://<this-pc>:4017/`.

Two click behaviours, remembered per browser:

- **One-click take** (default) — a scene button applies the transition settings,
  selects the scene and takes it, in one press.
- **Preview then take** — a scene button only loads preview; CUT or AUTO puts it
  on program.

Keyboard: <kbd>1</kbd>–<kbd>4</kbd> select a scene, <kbd>space</kbd> AUTO,
<kbd>C</kbd> CUT.

### .env

| Key | Default | Notes |
|---|---|---|
| `PORT` | `4017` | HTTP port for this API |
| `RCV_IP` | `192.168.0.0` | The switcher's IP — **must be set** |
| `RCV_PORT` | `10024` | OSC/TCP port on the device |
| `AUTO_CONNECT` | `true` | Connect on boot, or wait for `POST /api/rcv/connect` |
| `RECONNECT_INTERVAL` | `10000` | ms between reconnect attempts |
| `REFRESH_INTERVAL` | `10000` | ms between state refresh polls |

## Transitions

`GET /api/rcv/transitions` returns the catalog. Ids:

`fade`, `dipBlack`, `diagonal_1`, `diagonal_2`, `leftright`, `top_bottom`,
`box_tl`, `box_tr`, `box_br`, `box_bl`, `corners`, `barndoor-v`, `barndoor-h`

Duration is 0–60000 ms. `mirror` reverses a wipe's direction.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness + connection flag |
| GET | `/api/rcv/status` | Device, limits, PGM/PVW, full transition state |
| POST | `/api/rcv/connect` | Connect / reconnect (optional `ip` override) |
| POST | `/api/rcv/disconnect` | Disconnect and stop retrying |
| GET | `/api/rcv/scenes` | Scene bank names with live/preview state |
| GET | `/api/rcv/transitions` | Transition catalog |
| GET | `/api/rcv/transition` | Current transition, duration, mirror, switching mode |
| PUT | `/api/rcv/transition` | Set transition (`type`, optional `timeMs`, `mirror`) |
| PUT | `/api/rcv/transition/time` | Set duration (`ms`) |
| PUT | `/api/rcv/transition/mirror` | Reverse the wipe (`enabled`) |
| PUT | `/api/rcv/switching-mode` | `instant` \| `studioLeft` \| `toggle` |
| POST | `/api/rcv/source` | Select `input` \| `scene` \| `media` by index |
| POST | `/api/rcv/overlay` | Toggle an overlay bank |
| POST | `/api/rcv/take` | `auto` (transition) or `cut` |
| POST | `/api/rcv/transition/run` | One-shot: set + select + take |
| POST | `/api/rcv/raw` | Send an arbitrary OSC address/args |
| GET | `/api/rcv/show` | The live show dump as the device last sent it (raw XML) |
| GET | `/api/rcv/show/backups` | Archived show snapshots, newest first |
| GET | `/api/rcv/show/backups/{file}` | One snapshot, raw XML |

### Show snapshots

The device is the only copy of a show — the scene builds, overlay templates, bank names, stream
bindings and audio strips — and it offers no export. `/show` is already polled every 30 s to read
bank names, so the dump is kept verbatim in `data/shows/` (gitignored, newest 60, written only
when the content changes — `last_modified`, `Pgm/PvwScene` and `Pgm/PvwOverlay` move on every
button press and are excluded from that test). There is no OSC verb that loads a show back, so a
snapshot is read to rebuild by hand, not replayed.

### The link can be up and deaf

`connected` is a TCP fact. The device silently drops remote-control mode when its show is
reloaded or RØDE Central takes over, without closing the socket — after which `pgmcurrent` /
`pvwcurrent` never arrive again and PGM/PVW freeze while everything else looks fine. `/remote` is
therefore re-sent on every 10 s refresh tick (it is idempotent), and `/api/rcv/status` reports
`link: { lastRxAt, lastShowAt, stale }` so a consumer can tell a live link from a frozen one.

### Switching mode matters

- **instant** — selecting a source switches immediately, performing the active
  transition. A separate take is meaningless, and `/transition/run` skips it.
- **studioLeft** (studio mode) — selecting a source loads it to preview; the take
  (`auto` or `cut`) is what puts it on program.

### Example

```powershell
# 750 ms horizontal wipe from whatever is live to input 2
curl -X POST http://localhost:4017/api/rcv/transition/run `
  -H "Content-Type: application/json" `
  -d '{"type":"leftright","timeMs":750,"source":{"type":"input","index":2},"take":"auto"}'
```

## Model differences

Detected from UDP discovery. The **RCV S** and **Core** expose 5 input and 5
scene/media/overlay banks; the full RCV exposes 7 of each. Index validation follows
the detected model, falling back to the S limits when discovery gets no reply.

## Credits

Protocol derived from the RØDE/Bitfocus Companion module
[`companion-module-rode-rcv`](https://github.com/bitfocus/companion-module-rode-rcv)
(MIT). The OSC codec here is a self-contained ~130-line implementation, so this
project has no OSC dependency.
