# Kudominoes online rooms

A Cloudflare Worker with one Durable Object per room. It runs on the **free plan**: the Durable Object
uses SQLite storage, WebSocket hibernation and alarms. The contract with the game client is
`../src/net/protocol.ts`. The engine and roster are imported straight from `../src`, and wrangler
bundles them.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| `POST` | `/api/rooms[?pid=<playerId>]` | `201 { code }`. The optional `pid` becomes the host (otherwise the first player to say hello). |
| `GET` | `/api/rooms/:code` | `{ exists, phase?, freeSeats? }`. Also accepts lowercase codes and `KUDO-XXXX`. |
| `GET` | `/api/rooms/:code/ws?pid=<playerId>` | WebSocket. The first frame must be `hello`. |

CORS and WebSocket origins allowed: `https://rene-guerrero.github.io`, `https://localhost` and
`capacitor://localhost` (Capacitor), `http(s)://localhost:*` and `127.0.0.1:*`, LAN `http://192.168.*`
and `http://10.*`, and anything listed in the `KUDO_EXTRA_ORIGINS` var (comma-separated). Requests
with no `Origin` header (native apps) are allowed.

## How a room works

- **Lobby.** Arriving players sit in the first empty seat, or take over a CPU seat if none is empty.
  `sit` moves a player or makes them stand. The host picks the mode, player count, rules and CPU seats.
  `start` (host) seats anyone still standing, then fills empty seats with distinct roster CPUs.
- **Playing.** The server holds the MatchState and checks every move against `legalMoves`. Human turns
  have a 30 s deadline. When it runs out, a `normal` CPU plays that one move (`covered`, `timeout`).
  A dropped player keeps their seat. After 8 s of grace a CPU covers them (`cpuCovering`), and they
  take the seat back when they reconnect with the same `playerId`: `welcome` brings the full private
  view. A newcomer during a match can only take over a CPU seat. When the winning pair chooses its
  opener, the `turn` message carries `choosingStarter` and `starterTeam`. Any human in that pair may
  answer with `chooseStarter`; otherwise the CPU decides when the time runs out. After a hand ends,
  the next one is dealt after 7 s.
- **Finished.** The room keeps its seats. The host can change settings like in the lobby and then
  send `rematch` (or `start`). `leave` gives the seat to a CPU during a match (or empties it in the
  lobby), and the host passes to the next connected human.
- **Clean-up.** When nobody is connected the match pauses, and the room is deleted after 2 h.

**Persistence.** The whole room is one JSON value in DO storage. It is written after every change
and reloaded in the constructor, which also runs after hibernation. Socket identity is kept with
`serializeAttachment`. Every timer (turn deadline, CPU think delay of about 0.8–1.8 s, next deal,
disconnect grace, idle clean-up) sits in a small schedule. The single alarm is always set to the
earliest entry.

**Redaction** (`src/redact.ts`, unit-tested). Other seats' hands and the pozo in `handStart` become
`HIDDEN_TILE` placeholders of the same length. Another seat's `draw` carries `HIDDEN_TILE`. A
`SeatView` keeps only the player's own hand and empties the pozo (counts go in
`handCounts`/`pozoCount`). `MatchState.rng` is replaced with 0, because the deal can be rebuilt from it.

## Local development

Do not install anything globally. Keep caches on D:

```sh
cd server
export npm_config_cache='D:\Me\for-pleasure\.npm-cache' XDG_CONFIG_HOME='D:\Me\for-pleasure\.wrangler-home' WRANGLER_SEND_METRICS=false
npm install
npx wrangler dev --port 8787          # http://127.0.0.1:8787 (Miniflare runs the DO and alarms locally)
```

From the repo root, `npm run server:dev` does the same. Point the client at
`http://<your-pc-ip>:8787` (add `--ip 0.0.0.0` to reach it from a phone on the LAN).

Tests:

```sh
npm test                                   # unit tests (redaction, lobby rules, schedule, CPU pacing)
npx tsc --noEmit                           # type check
# end-to-end: shorter timers, then the Node driver (Node 22+)
npx wrangler dev --port 8787 --var KUDO_TURN_TIMEOUT_MS:1500 --var KUDO_GRACE_MS:800 --var KUDO_NEXT_HAND_MS:600 --var KUDO_CPU_SPEED:0.03
node test/integration.mjs
```

Test-only vars: `KUDO_TURN_TIMEOUT_MS`, `KUDO_GRACE_MS`, `KUDO_IDLE_TTL_MS`, `KUDO_NEXT_HAND_MS`,
`KUDO_CPU_SPEED` (multiplier on CPU think delays).

## Deploy

You need a free Cloudflare account. No `account_id` is hardcoded.

```sh
cd server
npx wrangler login      # opens the browser once; credentials are stored under XDG_CONFIG_HOME
npx wrangler deploy
```

The Worker is served at `https://kudominoes-rooms.<your-subdomain>.workers.dev`. The client uses:

- `POST https://kudominoes-rooms.<sub>.workers.dev/api/rooms`
- `wss://kudominoes-rooms.<sub>.workers.dev/api/rooms/<CODE>/ws?pid=<playerId>`

### GitHub Actions option

1. In the Cloudflare dashboard, create an API token from the **Edit Cloudflare Workers** template.
2. In GitHub, go to Settings → Secrets → Actions and add `CLOUDFLARE_API_TOKEN`. Add
   `CLOUDFLARE_ACCOUNT_ID` too if the token can reach more than one account.
3. Add a workflow such as `.github/workflows/server.yml`:

```yaml
name: Deploy room server
on:
  push:
    branches: [main]
    paths: ['server/**', 'src/engine/**', 'src/net/protocol.ts', 'src/roster.ts', 'src/contracts.ts']
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
        working-directory: server
      - run: npm test
        working-directory: server
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: server
```
