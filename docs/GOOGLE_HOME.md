# Google Home Integration

The relay acts as its own Google Smart Home Cloud-to-Cloud fulfillment server:
Google talks directly to your self-hosted instance over HTTPS (for example via
Cloudflare Tunnel), with no third-party automation service in between. Every
device in `WLED_DEVICES` appears in the Google Home app as a light with on/off,
brightness, colour, and 18 **effect** modes.

```
"Hey Google, turn the desk lights blue"
  → Google Assistant
  → POST https://wled.example.com/smarthome   (Bearer access token)
  → relay translates EXECUTE → WLED JSON
  → ESP32
```

## 1. How it works

| Endpoint | Purpose | Auth |
|---|---|---|
| `GET /oauth/authorize` | Login page shown once, when you link the account | `client_id` + Google-only `redirect_uri` |
| `POST /oauth/authorize` | Checks `ADMIN_PASSWORD`, redirects back to Google with a 5-min one-time code | password, rate-limited |
| `POST /oauth/token` | Code → access + refresh token; refresh → new access token | `client_id` + `client_secret` |
| `POST /smarthome` | SYNC / QUERY / EXECUTE / DISCONNECT intents | `Authorization: Bearer <access token>` |

These routes are **not** under `/api/v1`, so they never need
`x-relay-token` — Google authenticates with OAuth tokens instead. They are only
registered when the Google variables are set (startup log shows
`"googleSmartHome":"enabled"`).

### Tokens

- **Stateless and signed** (HMAC-SHA256 with `TOKEN_SIGNING_SECRET`). Nothing
  is stored on disk, so tokens **survive container recreates** — editing `.env`
  and recreating the container does not unlink Google Home.
- Access tokens expire after 24h; Google refreshes them automatically.
  Refresh tokens don't expire.
- **Kill switch:** change `TOKEN_SIGNING_SECRET` and recreate the container →
  every token is instantly invalid and Google Home is unlinked.
- `DISCONNECT` (you unlink in the app) revokes all tokens in memory. Use the
  kill switch if you need revocation to persist across restarts.

### Security measures

- `redirect_uri` must be `https://oauth-redirect.googleusercontent.com/r/...`
  (or the `-sandbox` variant), pinned to `/r/<GOOGLE_PROJECT_ID>` when set —
  login codes can't be sent anywhere else.
- Password and client-secret failures: 5 attempts per IP per 15 minutes
  (uses `cf-connecting-ip` when `TRUST_CLOUDFLARE=true`, otherwise socket IP),
  then `429`.
- Login page: `no-store`, no framing (`X-Frame-Options: DENY` + CSP
  `frame-ancestors 'none'`), CSP-restricted form targets.
- Constant-time comparison for every secret.

### Device mapping

| Google | WLED |
|---|---|
| `OnOff` `{on}` | `{"on": bool}` |
| `BrightnessAbsolute` 0–100 | `{"bri": round(v × 2.55)}`; 0 → `{"on": false}` |
| `ColorAbsolute` `spectrumRGB` | `{"seg":[{"id":0,"col":[[r,g,b]]}]}` |
| `SetModes` `effect` | `{"seg":[{"id":0,"fx":id}]}` |

Included effects (18 — Google's maximum per mode, verified against WLED 16.x):

| Setting | Voice synonyms | WLED `fx` |
|---|---|---|
| `solid` | solid, static, plain | 0 |
| `blink` | blink, flash | 1 |
| `breathe` | breathe, pulse | 2 |
| `wipe` | wipe | 3 |
| `colorloop` | color loop, colors, cycle colors | 8 |
| `rainbow` | rainbow | 9 |
| `theater` | theater, theater chase, cinema | 13 |
| `chase` | chase, running | 28 |
| `fireworks` | fireworks | 42 |
| `rain` | rain, drizzle | 43 |
| `pride` | pride, flowing rainbow | 63 |
| `fire` | fire, flame | 66 (Fire 2012) |
| `noise` | noise | 70 |
| `meteor` | meteor, comet, shooting star | 76 |
| `ripple` | ripple | 79 |
| `twinklefox` | twinkle, twinklefox, twinkly | 80 |
| `candle` | candle, flicker | 88 |
| `pacifica` | pacifica, ocean, waves | 101 |

To customize, edit `EFFECTS` in `src/google/traits.ts` — get IDs from
`http://<wled-ip>/json/effects` (array index = `fx` ID).

Devices sharing one IP are listed once (named entry preferred over `default`),
so `desk` and `default` → a single "Desk LED" tile.

## 2. Setup

### 2.1 Generate credentials in `.env`

Generate strong random values and add them to `.env`:

```bash
node -e "
const c = require('crypto');
const r = (n) => c.randomBytes(n).toString('base64url');
console.log('GOOGLE_CLIENT_ID=wled-relay-' + r(9));
console.log('GOOGLE_CLIENT_SECRET=' + r(32));
console.log('ADMIN_PASSWORD=' + r(15));
console.log('TOKEN_SIGNING_SECRET=' + r(48));
"
```

You'll paste `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` into the Google
console, and type `ADMIN_PASSWORD` on the authorization page when linking.

### 2.2 Create the integration in Google

1. Go to the **Google Home Developer Console** (<https://console.home.google.com>)
   and create a project. Note the **project ID**.
2. Add a **Cloud-to-cloud** integration.
3. Fill in (replace `wled.example.com` with your public HTTPS hostname):
   | Field | Value |
   |---|---|
   | OAuth Client ID | `GOOGLE_CLIENT_ID` from `.env` |
   | Client secret | `GOOGLE_CLIENT_SECRET` from `.env` |
   | Authorization URL | `https://wled.example.com/oauth/authorize` |
   | Token URL | `https://wled.example.com/oauth/token` |
   | Cloud fulfillment URL | `https://wled.example.com/smarthome` |
   Leave App Flip and Scopes empty.
4. Save, then set `GOOGLE_PROJECT_ID=<project id>` in `.env` and recreate the
   container (§3).

The integration stays in **test** mode — for personal/household use, that is
the intended end state (visible to Google accounts added as project members; no
Google certification required).

### 2.3 Link in the Google Home app

1. Google Home app → **+** → *Set up device* → *Works with Google Home*
2. Search for your integration (shown with a `[test]` prefix)
3. The relay's login page opens → enter `ADMIN_PASSWORD` → **Authorize**
4. Google runs SYNC → your lights appear. Assign them to rooms.

Then: *"Hey Google, turn on desk lights"*, *"set desk to 30%"*,
*"make the desk purple"*, *"set desk effect to pacifica"*.

Note: on the mobile Google Home app, long-press a light tile for brightness and
colour controls; effect buttons render natively on Nest Hub smart displays and
work via voice everywhere.

### 2.4 Adding devices later

Add to `WLED_DEVICES`, recreate the container, then say *"Hey Google, sync my
devices"* — the new light appears. No relinking.

## 3. Apply changes

```bash
docker rm -f wled-relay
docker run -d --name wled-relay --restart unless-stopped --env-file .env -p 3080:3080 wled-relay
docker logs wled-relay | grep googleSmartHome     # expect "enabled"
```

## 4. Manual testing (curl)

Replace values from your `.env`. `RU` must match `GOOGLE_PROJECT_ID`.

```bash
B=https://wled.example.com
CID=<GOOGLE_CLIENT_ID>; CS=<GOOGLE_CLIENT_SECRET>
RU=https://oauth-redirect.googleusercontent.com/r/<GOOGLE_PROJECT_ID>

# 1. Authorize page (expect 200 HTML)
curl -i "$B/oauth/authorize?client_id=$CID&redirect_uri=$RU&state=test&response_type=code"

# 2. Submit password → 302 to $RU?code=...&state=test (copy the code)
curl -si -X POST "$B/oauth/authorize" \
  --data-urlencode "client_id=$CID" --data-urlencode "redirect_uri=$RU" \
  --data-urlencode "state=test" --data-urlencode "response_type=code" \
  --data-urlencode "password=<ADMIN_PASSWORD>" | grep -i ^location

# 3. Exchange code for tokens
curl -s -X POST $B/oauth/token \
  -d "grant_type=authorization_code&code=<CODE>&client_id=$CID&client_secret=$CS&redirect_uri=$RU"

# 4. Refresh
curl -s -X POST $B/oauth/token \
  -d "grant_type=refresh_token&refresh_token=<REFRESH>&client_id=$CID&client_secret=$CS"

# 5. SYNC
curl -s -X POST $B/smarthome -H "authorization: Bearer <ACCESS>" \
  -H 'content-type: application/json' \
  -d '{"requestId":"1","inputs":[{"intent":"action.devices.SYNC"}]}'

# 6. QUERY
curl -s -X POST $B/smarthome -H "authorization: Bearer <ACCESS>" \
  -H 'content-type: application/json' \
  -d '{"requestId":"2","inputs":[{"intent":"action.devices.QUERY","payload":{"devices":[{"id":"desk"}]}}]}'

# 7. EXECUTE (turn on)
curl -s -X POST $B/smarthome -H "authorization: Bearer <ACCESS>" \
  -H 'content-type: application/json' \
  -d '{"requestId":"3","inputs":[{"intent":"action.devices.EXECUTE","payload":{"commands":[{"devices":[{"id":"desk"}],"execution":[{"command":"action.devices.commands.OnOff","params":{"on":true}}]}]}}]}'
```

## 5. Troubleshooting

| Symptom | Check |
|---|---|
| Linking page shows "Invalid redirect_uri" | `GOOGLE_PROJECT_ID` doesn't match the Google project |
| "Unknown client" | `GOOGLE_CLIENT_ID` in console ≠ `.env` |
| Linking fails after password | Client secret mismatch → `docker logs wled-relay` |
| "Too many attempts" | 5 failures in 15 min — wait, or recreate container |
| Light shows "offline" | ESP32 unreachable (`deviceOffline`) — check `/health` |
| New device missing | *"Hey Google, sync my devices"* |
| Google Home suddenly unlinked | `TOKEN_SIGNING_SECRET` changed |
