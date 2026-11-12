# WLED Relay — Usage Guide

The operational manual: how the service thinks, every endpoint in detail,
command recipes, deployment runbook, and troubleshooting.

## 1. Mental model

```
Caller (Google Home / IFTTT / dashboard / curl)
    │  HTTPS (OAuth Bearer or x-relay-token)
    ▼
Cloudflare Tunnel (wled.example.com)
    │  cloudflared → http://localhost:3080
    ▼
wled-relay (this service, in Docker or PM2)
    │  validate → translate → HTTP with 3s timeout
    ▼
ESP32 / WLED on the LAN (192.168.1.x)
```

**Nothing is hardcoded per command.** The service ships generic buttons —
power, brightness, color, effect, preset, raw. *What* a button does is decided
by the caller's payload. New voice command = new caller config. New device =
one `.env` line. Code changes are essentially never needed.

Every REST response uses one envelope:

```json
{ "success": true,  "data": { ... } }
{ "success": false, "code": "SOME_CODE", "message": "..." }
```

## 2. Devices

Configured in `.env`:

```env
WLED_HOST=http://192.168.1.100                          # registers "default"
WLED_DEVICES=desk=192.168.1.100,lamp=192.168.1.101      # named devices
```

- Name rules: lowercase `a-z 0-9 -`, unique, and not `status`, `power`,
  `toggle`, `brightness`, `preset`, `color`, `effect`, `raw`, `devices`.
- Fallback: the device named `default` — or the **first** listed if no
  `default` exists — answers un-prefixed routes (`/api/v1/wled/...`).
- Every route works both ways: `/api/v1/wled/status` (fallback device) and
  `/api/v1/wled/<name>/status` (explicit device).
- `.env` changes require a container **recreate** (see §6).

`GET /api/v1/devices` enumerates devices with live connectivity — a dashboard
can auto-discover instead of hardcoding names:

```json
{
  "success": true,
  "data": {
    "default": "default",
    "devices": [
      { "name": "desk", "host": "http://192.168.1.100",
        "connectivity": { "reachable": true, "lastChecked": "...", "lastError": null } }
    ]
  }
}
```

## 3. Authentication

- If `API_AUTH_TOKEN` is set, every `/api/v1/*` route requires
  `x-relay-token: <token>` **or** `Authorization: Bearer <token>`.
- `/health` is always open (it probes at most once every 10s and leaks no
  device names or host details).
- `ALLOW_LOCAL_UNAUTHENTICATED=true` lets plain loopback calls skip the token.
  Cloudflare Tunnel traffic is still challenged — detected via `cf-ray` /
  `cf-connecting-ip` headers, since the tunnel makes everything look like
  localhost. Leave it `false` unless you have a specific reason.
- `TRUST_CLOUDFLARE=true` enables reading `cf-connecting-ip` for OAuth login
  rate-limiting behind Cloudflare Tunnel. Set to `false` if exposing `PORT`
  directly without Cloudflare.

## 4. Endpoint reference

All examples use:

```bash
TOKEN="..."; H="x-relay-token: $TOKEN"
BASE="https://wled.example.com"       # or http://localhost:3080 on the LAN
DEV="desk"                            # omit for the default device
```

### `GET /health` — open

Service liveness and default WLED reachability (cached 10s).

### `GET /api/v1/devices` — list devices & live connectivity

Probes every device in parallel (bounded by `TIMEOUT_MS`).

### `GET /api/v1/wled/{dev/}status`

Normalized strip state:

```json
{ "success": true, "data": { "on": true, "brightness": 128, "preset": -1,
  "leds": 120, "wifiRssi": -58, "name": "WLED", "version": "16.0.1",
  "mac": "aabbccddeeff" } }
```

### `POST /api/v1/wled/{dev/}power` — `{ "on": true|false|"toggle" }`

`"toggle"` → WLED `{"on":"t"}`.

### `GET /api/v1/wled/{dev/}toggle`

GET-friendly toggle for webhook callers that can't POST.

### `POST /api/v1/wled/{dev/}brightness`

```json
{ "value": 160 }                        // absolute 0–255
{ "value": -40, "relative": true }      // delta −255..255 → WLED {"bri":"-40"}
```

### `GET|POST /api/v1/wled/{dev/}preset/:id` — apply preset 1–250

### `POST /api/v1/wled/{dev/}color`

```json
{ "hex": "#FF8800" }                    // or
{ "rgb": [255, 136, 0] }
{ "hex": "FF8800", "segment": 1 }       // optional segment 0–31
```

### `POST /api/v1/wled/{dev/}effect`

```json
{ "effectId": 9, "speed": 128, "intensity": 200, "paletteId": 11, "segment": 0 }
```

Only `effectId` is required. Effect/palette IDs: see the WLED app or
<https://kno.wled.ge/features/effects/>.

### `POST /api/v1/wled/{dev/}raw` — the escape hatch

Any JSON object is forwarded verbatim to `http://<device>/json/state`. If WLED
can do it, `/raw` can send it — no route needed:

```bash
# Nightlight: fade to off over 30 minutes
curl -H "$H" -X POST $BASE/api/v1/wled/$DEV/raw \
  -H 'content-type: application/json' -d '{"nl":{"on":true,"dur":30}}'

# 2-second crossfade for this command only
-d '{"transition":20,"seg":[{"col":[[0,0,255]]}]}'

# Multiple segments at once
-d '{"seg":[{"id":0,"col":[[255,0,0]]},{"id":1,"col":[[0,255,0]]}]}'

# WLED playlist (saved as a preset id)
-d '{"ps":12,"on":true}'
```

WLED state fields reference: <https://kno.wled.ge/interfaces/json-api/>.

## 5. Error codes

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body/params failed schema — `issues[]` shows the fields |
| 400 | `BAD_REQUEST` | Malformed JSON / unreadable body |
| 401 | `UNAUTHORIZED` | Missing/invalid `x-relay-token` |
| 404 | `NOT_FOUND` | No such route |
| 404 | `UNKNOWN_DEVICE` | Device name not in `WLED_DEVICES` |
| 502 | `TARGET_UNREACHABLE` | ESP32 timed out/refused connection — check power, IP, Wi-Fi |
| 502 | `TARGET_ERROR` | ESP32 answered with a non-2xx status |
| 500 | `INTERNAL_ERROR` | Bug — check `docker logs wled-relay` |

Stack traces are never returned to callers.

## 6. Runbook

```bash
# rebuild after code changes
docker build -t wled-relay .

# apply .env changes (env is baked at creation — restart is NOT enough)
docker rm -f wled-relay
docker run -d --name wled-relay --restart unless-stopped \
  --env-file .env -p 3080:3080 wled-relay

# inspect
docker logs -f wled-relay
docker ps
curl http://localhost:3080/health
```

Cloudflare Tunnel: point a public hostname (e.g. `wled.example.com`) at
`http://localhost:3080`. If the tunnel token is rotated in the Cloudflare
dashboard, reinstall the `cloudflared` service with the new token or it will
fail after the next reboot.

## 7. Caller wiring

### Google Home (native)

The relay is a Google Smart Home Cloud-to-Cloud integration — lights appear
as native tiles in the Google Home app. Setup, security model and testing:
[GOOGLE_HOME.md](GOOGLE_HOME.md).

### IFTTT (webhook → relay)

- IF: any trigger
- THEN: Webhooks → Make a web request
  - URL: `https://wled.example.com/api/v1/wled/desk/power`
  - Method: `POST` · Content type: `application/json`
  - Additional headers: `x-relay-token: <token>`
  - Body: `{"on":"toggle"}`

### Custom dashboard

Poll `GET /api/v1/devices`, render a tile per device, drive it via
`/api/v1/wled/<name>/*`. All state needed for UI is in `status` (on,
brightness, preset, LEDs, RSSI).
