# Local play (Wi-Fi and Bluetooth) for Kudominoes and KuCards — plan

Status: **plan only, nothing built.** Written 2026-11-20. Web facts were checked that day; sources are
in section 11. Items marked **(to verify)** are claims I could not confirm from a primary source and
that a short spike must settle before we depend on them.

## 1. Recommendation in short

1. **Primary path: the Android app hosts the room over Wi-Fi.** The phone runs the room logic and a
   small HTTP + WebSocket server on the local network. That server also serves the game's own web
   build. Other players open `http://<phone-ip>:<port>/?sala=XXXX` in any browser (PC or phone), by
   typing it or scanning a QR. No internet is needed, and the phone's own hotspot works when there is
   no router. The wire protocol (`ClientMsg` / `ServerMsg`) does not change.
2. **Phone to phone without any network: Google Nearby Connections** (Bluetooth, BLE and Wi-Fi chosen
   by Android), as a second listener feeding the same room. Android app only.
3. **Bluetooth with a PC browser is not a realistic main path.** A browser can never host over
   Bluetooth. A PC can only *join* a phone-hosted room over BLE, in Chrome or Edge only, through an
   experimental GATT bridge. It is an optional spike, not a promise. A zero-code alternative worth
   trying first: Android Bluetooth tethering gives the PC an IP link to the phone, and path 1 then
   runs over Bluetooth unchanged **(to verify)**.
4. **A PC browser cannot host offline.** Browsers have no listening sockets. For development, a small
   Node script on the PC hosts the same room logic. WebRTC with copy-paste signaling is possible but
   the UX is poor; it stays an optional later item.

The work that makes all of this cheap is **Phase 0: give Kudominoes the platform-free `RoomCore` that
KuCards already has.**

## 2. What the code looks like today

### Client side (both games, nearly identical)

- `src/net/client.ts` already has the client transport abstraction:
  - `Conn` — the small part of a WebSocket the client uses (`send`, `close`, `onopen`, `onmessage`,
    `onclose`).
  - `Backend` — `createRoom(playerId)`, `roomInfo(code)`, `connect(code, playerId): Conn`.
  - `httpBackend(base)` — the real one. `RoomClient` (reconnect, ping/pong clock offset, `hello`)
    only ever talks to a `Backend`.
- `src/net/mock/backend.ts` — a `Hub` that hosts rooms in one tab and carries string frames to other
  tabs over `BroadcastChannel`. Its same-tab branch is exactly the "host plays on the hosting device"
  loopback we need. The two games' copies differ in four lines.
- `src/app/online.ts` picks the backend in `ensureBackend()`; `src/net/config.ts` has `serverUrl()`,
  `shareLink()`, `onlineAvailable()`. `src/main.ts` joins from `?sala=XXXX`.
- `client.ts`, `config.ts`, `identity.ts` are the same file in both games apart from names and URLs.

### Room side (the two games differ here)

| | Kudominoes | KuCards |
| --- | --- | --- |
| Server room logic | Inline in the Durable Object class, `server/src/room.ts` (619 lines), tied to `cloudflare:workers` | Platform-free `RoomCore<S>` in `server/src/core.ts` (620 lines); `server/src/room.ts` is a 115-line adapter |
| Host platform interface | none | `CoreIO<S>`: `now`, `random`, `seed`, `sockets`, `attachment`, `setAttachment`, `send`, `close`; plus `Tunables` |
| Dev mock room | `src/net/mock/room.ts`, 474 lines, a **second implementation** of the room (its header says "It is NOT the real server") | `src/net/mock/room.ts`, 96 lines, wraps the real `RoomCore` with `setTimeout` as the single alarm |
| `lobby.ts`, `schedule.ts`, `game.ts` | no Cloudflare imports | no Cloudflare imports |

So KuCards is already "room logic on any host behind a transport". Kudominoes is not: shipping its
mock room as a local host would mean two room implementations drifting apart. Phase 0 fixes that.

### App shell

- Capacitor 8.6, `appId` `com.kudominoes.app` / `com.kucards.app`, `allowMixedContent: false`,
  `targetSdkVersion` 36, `minSdkVersion` 24. No custom native code yet (`MainActivity.java` only).
  The manifest has only `INTERNET` and `VIBRATE`.
- `npx cap sync` copies `dist/` to `android/app/src/main/assets/public/` — the full web build is
  inside the APK, which is what lets the phone serve it to browsers.
- CI (`.github/workflows/deploy.yml`) builds the web app and a debug APK. A local plugin that ships
  inside an npm dependency is picked up by `cap sync` with no workflow change.

## 3. What a browser can and cannot do

| Capability | Reality |
| --- | --- |
| Listen for connections (TCP/UDP/WebSocket server) | **No.** A page can only connect out. A browser can never be a LAN host by itself. |
| Web Bluetooth | Chrome and Edge on Windows 10 1703+, macOS, ChromeOS and Android 6+. **Not** Firefox, **not** Safari, **not** iOS, **not** Android WebView (so not inside our Capacitor app). Linux is behind a flag. Needs a secure context and a click. The API models the page as a GATT **client** talking to remote peripherals; there is no API to advertise or serve GATT, so a page cannot be a peripheral. |
| HTTPS page → `http://` or `ws://` LAN host | Blocked as mixed content. The GitHub Pages build cannot simply connect to `ws://192.168.x.x`. |
| Chrome Local Network Access (LNA) | Chrome 142 added a permission prompt for public-site → local-network requests, and permission-gated requests to a **private IP literal** or `.local` name are exempt from mixed content. Chrome 147 (April 2026) extended LNA to WebSockets. So in recent Chrome the GitHub Pages build may be able to reach `ws://192.168.x.x` after a prompt **(to verify for WebSockets)**. Chromium only; Firefox and Safari still block. Not something to depend on. |
| WebRTC data channels | Work on a LAN without a server once connected, are not subject to mixed content, and work in Android WebView. But the two sides must first exchange an offer and an answer (signaling). Chrome hides local IPs behind mDNS `.local` names, which only resolve inside the same multicast domain. |
| Page served from `http://<lan-ip>` | Works, but it is **not a secure context**: no service worker, no `navigator.clipboard`, no `navigator.share`, no Wake Lock, no Web Bluetooth. `localStorage` belongs to that IP and port. |

### Consequences of the mixed-content rule

- A browser player cannot use the GitHub Pages build to join a LAN host. **The host must serve the
  game itself over plain HTTP**, so page and socket share one `http://` origin. This also removes
  the need for internet to load the game.
- The Capacitor app's WebView origin is `https://localhost`, so the same rule blocks a plain
  `new WebSocket('ws://192.168…')` inside the app. Two ways out: set `allowMixedContent: true` and
  allow cleartext, or route the socket through native code. I recommend the native route (section 6).
- Offline signaling for WebRTC through the Cloudflare server contradicts "without internet". If
  internet is available, normal online play already works.

### WebRTC signaling options, honestly

| Option | Works offline | UX |
| --- | --- | --- |
| Existing Cloudflare server relays offer/answer | No | Good, but pointless: with internet, online rooms already work |
| QR both ways (offer QR, then answer QR) | Yes | Two scans per joiner; the PC needs a camera to read the answer. `BarcodeDetector` is not available in Chrome on Windows **(to verify)**, so a JS decoder would be needed |
| Copy-paste offer/answer text | Yes | Needs another channel to pass the text; fine for a developer, poor for family |

Verdict: WebRTC only earns its place for "PC browser hosts, offline". Low priority.

## 4. What the Android app can do through Capacitor

| Capability | Existing plugin | Assessment |
| --- | --- | --- |
| WebSocket server | `capacitor-websocket-server` 0.0.1 (March 2026, one commit, Capacitor 8) | WebSocket only, no static HTTP, no track record. **Do not use.** |
| HTTP server | `@cantoo/capacitor-http-server` 1.0.8 (Aug 2026, Capacitor 6–8) | Routes every request through JavaScript; no WebSocket. Would serve three.js and textures through the bridge. **Not a fit.** |
| HTTP + WebSocket on one port, serving APK assets | none found | **Small custom plugin** (section 6) |
| Service discovery (mDNS / NSD) | `capacitor-zeroconf` 4.0.0 (May 2025, Capacitor 7+) | Usable, but `NsdManager` is about 60 lines inside our own plugin, and on Android 17 addresses resolved by `NsdManager` need no extra permission |
| BLE central | `@capacitor-community/bluetooth-le` 8.4.0 (Nov 2026) | Maintained, but **central role only** by its own docs. Does not help a phone host. |
| BLE peripheral (GATT server) | `@capgo/capacitor-bluetooth-low-energy` 8.2.9 (Nov 2026, Capacitor 8, MPL-2.0) | Has `startAdvertising`, `addGattService`, `notifyGattCharacteristicChanged`, `gattCharacteristicWriteRequest`. The candidate for the BLE spike. Capawesome's BLE plugin also has a peripheral role but is a paid tier. |
| Nearby Connections | `capacitor-nearby-plugin` 1.0.0 (one release, May 2025); `@squareetlabs/capacitor-nearby-multipeer` 1.1.30 (July 2025, Capacitor 7 only); `@enertrag/p2pconnect` 8.5.0 (Nov 2026, maintained, but **file transfer only**, no message stream) | None fits: wrong Capacitor version, no usage, or wrong payload type. **Small custom plugin.** |
| Wi-Fi Direct | none maintained found | Skip. Nearby Connections already uses Wi-Fi Direct and hotspot upgrades internally. |
| QR scan inside the app | `@capacitor/barcode-scanner` 3.1.4 (official, Nov 2026) or `@capacitor-mlkit/barcode-scanning` 8.2.2 | Optional. A QR that holds an `http://` URL is opened by the phone's own camera app. |
| Keep the screen on | `@capacitor-community/keep-awake` 8.0.1 | Use on the host. |
| QR drawing | `qrcode-generator` 2.0.4 (pure JS, no dependencies) | Use in the lobby. |

Nearby Connections facts (Google docs): works with no internet and no shared network; the Star
strategy is one hub and N spokes, which matches host and joiners. It needs Google Play services and
a set of runtime permissions (section 9).

## 5. Which combinations work

Host is always the device that runs the room. "App" is the Android APK.

| Host → joiner | Same Wi-Fi or phone hotspot | Bluetooth, no network |
| --- | --- | --- |
| Phone app → phone app | **Yes.** Native WebSocket client, found by NSD ("Partidas cercanas") or by IP | **Yes**, Nearby Connections (Phase 4) |
| Phone app → phone browser | **Yes.** Scan the QR, plays the web build served by the host | No |
| Phone app → PC browser | **Yes. Primary test path.** Type or scan the URL | Experimental only: BLE GATT bridge, Chrome/Edge (Phase 5). Try Bluetooth tethering first |
| PC browser → anyone | **No** (a page cannot listen) | **No** |
| PC with the Node dev script → phone or PC browser | **Yes**, development only | No |
| PC browser ↔ PC browser | Yes if a phone app hosts and both join it. Without a phone: Node script, or WebRTC with manual signaling | No |
| GitHub Pages build → LAN host | Blocked by mixed content, except possibly recent Chrome with the LNA prompt **(to verify)** | — |

Recommended order of preference for players:

1. Same Wi-Fi: host on a phone, others join by QR or nearby list.
2. No router: the host turns on its hotspot; same as 1.
3. Two or more Android phones and no network at all: Nearby Connections.
4. Internet available: the existing online rooms.

## 6. Design: how the transport plugs in

### 6.1 Principle

Frames are already JSON strings on both sides. Everything new is "carry strings between a `Conn` on
the joiner and a socket handle on the host". `ClientMsg`, `ServerMsg`, `RoomClient`, the lobby UI and
the room logic stay as they are.

```
joiner:  online.ts → RoomClient → Backend.connect() → Conn ──strings──┐
                                                                      │  (WS / Nearby / BLE / loopback)
host:    LocalHost ← Listener.onLink(Link) ← ─────────────────────────┘
            └→ LocalRoom (RoomCore + setTimeout alarm) → engine, CPU, redaction
```

### 6.2 Client side: new `Backend`s (interface unchanged)

| Backend | Used by | How |
| --- | --- | --- |
| `httpBackend(location.origin)` | Browser that loaded the game from a local host | **Existing code.** The local host implements the same three routes as the Worker: `POST /api/rooms`, `GET /api/rooms/{code}`, `GET /api/rooms/{code}/ws?pid=` |
| `loopbackBackend(host)` | The hosting device's own player | The same-tab branch of today's `mock/backend.ts` `Hub.connect` |
| `nativeWsBackend(address)` | App joining another phone over Wi-Fi | `Conn` backed by the plugin's native WebSocket client (avoids mixed content) |
| `nearbyBackend(endpoint)` | App joining over Nearby | `Conn` over Nearby BYTES payloads |
| `bleBackend(device)` (optional) | PC Chrome joining over Web Bluetooth | `Conn` over two GATT characteristics with chunking |

### 6.3 Host side: new small interfaces

```ts
/** one joiner's connection, as the host sees it */
interface Link {
  send(data: string): void;
  close(): void;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
}
/** something that accepts joiners: WebSocket server, Nearby, BLE, BroadcastChannel (dev) */
interface Listener {
  start(room: { code: string; name: string }): Promise<JoinInfo>; // urls, addresses, QR text
  stop(): Promise<void>;
  onLink: ((link: Link, pid: string | null) => void) | null;
  roomInfo: (() => RoomInfoResponse) | null; // answers GET /api/rooms/{code}
}
```

- `LocalRoom` — KuCards' `src/net/mock/room.ts` promoted to production: `RoomCore<Link>` plus a
  `setTimeout` alarm. The dev mock becomes `LocalRoom` with a clock skew option.
- `LocalHost` — owns one `LocalRoom` and any number of `Listener`s **at the same time**, so one room
  can take Wi-Fi and Nearby joiners together.
- `RoomCore.data` is one JSON value (the Durable Object stores it as is). The host can save it to
  `localStorage` after each change and offer "Reanudar partida" if the app is restarted.

### 6.4 Where the shared code lives

- Game-specific: `RoomCore`, `lobby.ts`, `schedule.ts`, `game.ts`, `redact.ts`. Move them from
  `server/src/` to `src/net/room/` in each game, so the client bundle and `tsconfig` (`include:
  ["src"]`) see them. `server/src/room.ts` imports them from there, as it already imports
  `../../src/engine`.
- Game-agnostic: `Link`, `Listener`, `LocalHost`, the new backends, the Android plugin, the Node dev
  host. Both games need identical copies. Put them in a small shared repository consumed like
  `kuavatars` (`github:rene-guerrero/kulocal#vX.Y.Z`), which carries the TypeScript and the Android
  plugin. `LocalHost` takes the room as a parameter (`{ accept, message, socketGone, info }`), so it
  knows nothing about dominoes or cards.

### 6.5 The Android plugin (`KuLocal`, custom, small)

One plugin, used by both games, in Java or Kotlin, roughly 400–600 lines over two phases.

Wi-Fi part (Phase 2):

- `startServer({ port? })` → `{ port, addresses[] }`. One embedded server on one port that serves
  the APK's `assets/public/` as static files and upgrades `/api/rooms/{code}/ws` to WebSocket.
  Candidate library: NanoHTTPD with its WebSocket module (tiny, one dependency, but unmaintained
  since 2016) or Ktor server (maintained, heavier). Decide in the spike **(to verify)**.
- Events `linkOpen { id, pid }`, `linkMessage { id, data }`, `linkClose { id }`; methods
  `send({ id, data })`, `close({ id })`. `GET /api/rooms/{code}` is answered from a value the
  JavaScript side pushes with `setRoomInfo()`, so that route needs no bridge round trip.
- `advertise({ name, code })` / `discover()` with `NsdManager`, service type `_kudominoes._tcp` or
  `_kucards._tcp`.
- `connect({ url })` — native WebSocket client for app joiners, same event shape.
- `getAddresses()` — includes the hotspot interface.

Nearby part (Phase 4): `startAdvertising`, `startDiscovery`, `requestConnection`,
`acceptConnection`, `sendBytes`, with `Strategy.P2P_STAR` and BYTES payloads (limit about 32 KB per
payload **(to verify)**; our frames are far smaller).

### 6.6 Changes per game

Kudominoes:

| File | Change |
| --- | --- |
| `server/src/room.ts` | Split: room logic → `src/net/room/core.ts` as `RoomCore<S>` + `CoreIO<S>` (copy KuCards' shape); what remains is the Durable Object adapter. **Redeploy the Worker after tests pass.** |
| `server/src/lobby.ts`, `schedule.ts`, `game.ts`, `redact.ts` | Move to `src/net/room/` (`server/src/redact.ts` and `src/net/redact.ts` are the same 55 lines: keep one) |
| `server/test/*` | Add a `core.test.ts` like KuCards'; keep `integration.mjs` green against `wrangler dev` |
| `src/net/mock/room.ts` | Delete the 474-line reimplementation; replace with the thin `RoomCore` wrapper |
| `src/net/mock/backend.ts` | Becomes the dev `BroadcastChannel` `Listener` + `loopbackBackend` |
| `src/net/client.ts` | No change to `Conn`, `Backend`, `RoomClient` |
| `src/net/config.ts` | `serverUrl()` returns `location.origin` when the page was served by a local host (the host answers `GET /api/local`, or injects a flag into `index.html`); `shareLink()` returns the host URL for local rooms; new `localPlayAvailable()` |
| `src/app/online.ts` | `ensureBackend()` takes the chosen mode (online / host local / join local); host start and stop; the version error text for local play. The rest of the 1,152 lines is untouched |
| `src/ui/online.ts` | Home screen: "Jugar cerca" section (host, nearby list, join by address). Lobby: QR, address, "keep this phone open" note |
| `src/ui/menu.ts`, `src/ui/i18n.ts` | Menu entry and strings (Spanish first, English second) |
| `src/main.ts` | Nothing for `?sala=`. Hide the APK download button and skip the service worker when served from a LAN host (the service-worker guard already skips non-HTTPS origins) |
| `capacitor.config.ts`, `android/` | Plugin via `cap sync`; permissions come from the plugin's manifest. `allowMixedContent` stays `false` |

KuCards:

| File | Change |
| --- | --- |
| `server/src/core.ts`, `lobby.ts`, `schedule.ts`, `game.ts` | Move to `src/net/room/` (imports only) |
| `src/net/mock/room.ts` | Promote to `LocalRoom` (remove "DEV ONLY", make the skew an option) |
| `src/net/mock/backend.ts`, `config.ts`, `src/app/online.ts`, `src/ui/online.ts`, `i18n.ts`, `src/main.ts` | Same changes as Kudominoes |
| KuCards-specific check | Out-of-turn moves and the response window (`WINDOW_MS`) are "first come, first served". On a LAN that is fine; over BLE (slow) the window may need to be longer |

Protocol: **no new message fields** for local play. `PROTOCOL_VERSION` is 2 because double-nine added a
`tileSet` rule (older clients cannot render pips 7–9 or understand the new tile ids), carried inside
the existing `rules` record. Two app installs of different versions can meet; `version_mismatch`
handles it and asks both devices to update. Browser joiners always match, because the host serves
them its own build.

### 6.7 Behaviour differences from online rooms

- **The host device holds every hand in memory.** Fine for family play; say so in the lobby only if
  asked. Joiners still receive only their redacted view.
- **If the host leaves, the room ends.** There is no host migration. A saved `RoomData` lets the
  same host resume.
- **Timers run in the host's WebView.** If the host app goes to the background, timers stall and
  sockets may drop. On return, `RoomCore.alarm()` processes everything that came due (it is already
  written for a Durable Object waking from hibernation), and clients reconnect through `RoomClient`.
- Clock differences between devices are already handled by ping/pong (`serverNow`).

### 6.8 UI text (neutral Spanish first, English second)

| Key | Spanish | English |
| --- | --- | --- |
| `menu.local` | Jugar cerca | Play nearby |
| `local.intro` | Juega con quienes están contigo, sin internet. Un teléfono crea la partida y los demás se unen. | Play with the people around you, without internet. One phone creates the game and the others join. |
| `local.host` | Crear partida en este teléfono | Create a game on this phone |
| `local.nearby` | Partidas cercanas | Nearby games |
| `local.joinAddress` | Unirse con una dirección | Join with an address |
| `local.sameWifi` | Conecten todos los dispositivos a la misma red Wi-Fi, o activa la zona Wi-Fi de este teléfono. | Connect every device to the same Wi-Fi network, or turn on this phone's hotspot. |
| `local.scan` | Escanea el código o abre esta dirección en el navegador | Scan the code or open this address in the browser |
| `local.keepOpen` | Mantén el juego abierto en este teléfono. Si lo cierras, la partida termina. | Keep the game open on this phone. If you close it, the game ends. |
| `local.err.version` | Las versiones del juego son distintas. Actualicen el juego en ambos dispositivos. | The game versions differ. Update the game on both devices. |

Both games keep their own original names, art and wording; nothing here is taken from another product.

## 7. Phases and rough effort

Effort is in working days for one developer, including device testing. Treat it as ±50%.

| Phase | What | Effort | Done when |
| --- | --- | --- | --- |
| **0. One room core** | Kudominoes: extract `RoomCore` from the Durable Object, move room files to `src/net/room/`, replace the mock room, add `core.test.ts`, redeploy the Worker. KuCards: move files only | Kudominoes 2–3 d, KuCards 0.5 d | Online play and `?mpmock=1` behave as before in both games; all tests green |
| **1. Local layer + PC dev host** | `Link`, `Listener`, `LocalHost`, `loopbackBackend` in the shared `kulocal` repo. A Node script (`npm run lan`) that serves `dist/` and runs the room with the `ws` package. `serverUrl()` same-origin rule. Minimal "Jugar cerca" UI | 2–3 d | PC hosts with the script; the phone's browser and a second PC browser join by URL and play a full match with Wi-Fi internet unplugged |
| **2. Android Wi-Fi host** | `KuLocal` plugin: static HTTP + WebSocket server, NSD, native WebSocket client, addresses. QR in the lobby, keep-awake, saved-room resume | 4–6 d | The phone hosts; the PC browser joins by QR or URL over the home Wi-Fi and over the phone's hotspot |
| **3. KuCards adoption** | Wire the shared layer and UI into KuCards; tune the response window | 1–2 d | Same test as Phase 2 for KuCards |
| **4. Nearby Connections** | Nearby part of the plugin, `nearbyBackend`, permission flow, discovery UI | 4–6 d | Two Android phones in airplane mode with Bluetooth on play a match. **Needs a second Android phone to test.** |
| **5. Optional spikes** | (a) Bluetooth tethering test, 0.5 d. (b) BLE GATT bridge for PC Chrome, 3–5 d, may fail. (c) WebRTC with manual signaling for a browser host, 3–4 d. (d) Chrome LNA from GitHub Pages, 0.5 d | as chosen | Each ends with a keep / drop decision |

Phases 0–3 deliver the stated goal for Wi-Fi on the phone + PC setup: about 10–15 days. Bluetooth for
phones adds 4–6 days and a second phone.

## 8. Test plan (Android phone + Windows PC)

Build and run rules: everything stays on drive D (project `node_modules`, Gradle and npm caches as
already configured); no global installs.

Phase 0

- `npm test`, `npm run server:test`, `server/test/integration.mjs` against `wrangler dev`.
- Two tabs with `?mpmock=1`: full match, reconnect (reload a tab), turn timeout, CPU cover, rematch.
- One online match against the redeployed Worker, phone app + PC browser.

Phase 1 (PC hosts with the Node script)

- PC Chrome at `http://localhost:<port>` and phone Chrome at `http://<pc-ip>:<port>/?sala=XXXX`.
- Allow Node through Windows Firewall on the private network when Windows asks.
- Unplug the router's internet: play a full match. Reload the phone page mid-hand: the seat is
  restored. Lock the phone for 20 s: a CPU covers, then the player returns.
- Check on the insecure origin: name and avatar entry, share/copy fallback, sound, fullscreen, no
  service-worker errors in the console.

Phase 2 (phone hosts)

- Home Wi-Fi: phone creates, PC Chrome joins by typing the address; then Edge and Firefox.
- Phone hotspot with mobile data off: PC joins the hotspot, then the game.
- Host goes to the background for 10 s and for 60 s: the PC shows "Reconectando…" and recovers, or
  the room is declared lost cleanly.
- Host screen stays on during a 20-minute match; note battery use and warmth.
- Kill and reopen the host app: "Reanudar partida" restores the room and the PC rejoins.
- Guest Wi-Fi (client isolation): confirm the failure is explained on screen, not a silent spinner.
- If a second phone can be borrowed: app-to-app join through the nearby list.

Phase 4: needs two Android phones. Airplane mode + Bluetooth; deny each permission once and check
the explanation screen; walk the phones apart until the link drops and check the reconnect.

Phase 5 spikes: each has a single pass/fail script written before starting.

## 9. Risks

Android permissions

- Wi-Fi hosting on `targetSdk` 36 needs no runtime prompt (`INTERNET`, `ACCESS_WIFI_STATE`,
  `ACCESS_NETWORK_STATE`). **Android 17 changes this:** apps that target SDK 37 must hold the new
  runtime permission `ACCESS_LOCAL_NETWORK` for LAN traffic; apps on a lower target keep access for
  now, and Google calls that temporary. Plan the prompt and its explanation text now.
- Nearby Connections needs, per Google's manifest block: `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`,
  `BLUETOOTH_SCAN` (API 31+), `NEARBY_WIFI_DEVICES` (API 33+), `ACCESS_FINE_LOCATION` (API 29–32),
  `ACCESS_COARSE_LOCATION`, legacy `BLUETOOTH` / `BLUETOOTH_ADMIN` (≤ 30), Wi-Fi state permissions,
  and `ACCESS_LOCAL_NETWORK` (API 37+). If any is denied, advertising and discovery do not start. On
  Android 12 and older, location must also be switched on **(to verify)**. This is a heavy first-run
  moment for a family game; it needs one clear screen before the system dialogs.
- Nearby depends on Google Play services. Phones without it cannot use that path.

Battery and backgrounding

- The host runs the room in the WebView. Backgrounding stalls timers; long backgrounding kills
  sockets. Mitigations: keep-awake on the host, the "keep this phone open" note, catch-up on resume,
  saved room. A foreground service would keep native sockets alive but not the JavaScript room, so it
  is not worth its extra permission and notification.
- Hotspot + screen on + three.js rendering drains the host. Offer the existing low-quality setting.

Discovery and joining UX

- Browser joiners cannot discover anything; they need the URL or QR. Typing `192.168.1.37:8787` is
  unfriendly, so the QR is the main path and the address is shown large as a fallback.
- Router client isolation (guest networks, some public Wi-Fi) blocks device-to-device traffic. The
  hotspot is the answer, and the error text must say so.
- An `http://` IP origin has its own `localStorage`: a browser joiner sets name and avatar again, and
  if the host's IP changes mid-session the joiner becomes a new player. Acceptable; DHCP leases
  rarely change within an evening.
- Fixed port: choose one default port per game and fall back to a free port if taken.

Platform and library risks

- **A second Android phone is needed** to test Nearby and app-to-app joining. With one phone and one
  PC, only the browser-joiner paths can be verified.
- The embedded HTTP/WebSocket library choice (old but tiny, or maintained but heavy) is open.
- Refactoring the deployed Kudominoes server (Phase 0) can break online play; the integration test
  and a staged redeploy cover it.
- BLE bridge: small MTU needs chunking, the Windows Bluetooth stack is uneven, Chrome/Edge only, and
  the PC must load the game from an HTTPS origin (the cached GitHub Pages PWA). High chance of "works
  on my machine only".
- Chrome LNA rules are still moving (WebSockets joined in Chrome 147; WebRTC is not gated yet).
  Nothing in the main path depends on them, because host and page share one local origin.

iOS later

- An iPhone can already **join** a phone-hosted game from Safari over Wi-Fi (plain HTTP page).
- iOS **hosting** needs a Capacitor iOS build plus a Swift half of the plugin (Network.framework),
  and the iOS local-network permission string.
- Bluetooth between Android and iOS has no shared system API here: Nearby Connections is the Android
  path, MultipeerConnectivity is Apple-only, and Safari has no Web Bluetooth. Cross-platform phone
  play stays on Wi-Fi.

## 10. Open decisions for the user

1. Shared `kulocal` repository (like `kuavatars`) or a copy of the layer in each game?
2. Is Bluetooth for phones (Phase 4) wanted now, given it needs a second Android phone and a
   permission-heavy first run? Hotspot Wi-Fi already covers "no router".
3. Should the BLE-to-PC spike be tried at all, or dropped in favour of the tethering test?

## 11. Sources (checked 2026-11-20)

Browser capabilities

- Web Bluetooth implementation status (platforms, WebView unsupported, Firefox and Safari positions):
  https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md
- MDN, Web Bluetooth API (secure context, transient activation, remote GATT server model):
  https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API
- caniuse, Web Bluetooth: https://caniuse.com/web-bluetooth
- Chrome, Local Network Access permission prompt (Chrome 142, mixed-content exemption for private IP
  literals and `.local`): https://developer.chrome.com/blog/local-network-access
- Blink Intent to Ship, LNA restrictions for WebSockets (Chrome 147):
  https://groups.google.com/a/chromium.org/g/blink-dev/c/O6GMKt44Ups
- Chrome 147 release notes: https://developer.chrome.com/release-notes/147
- WebRTC mDNS candidates: https://datatracker.ietf.org/doc/html/draft-ietf-mmusic-mdns-ice-candidates
  and https://bloggeek.me/webrtcglossary/mdns

Android

- Nearby Connections, get started (permission block incl. `ACCESS_LOCAL_NETWORK`):
  https://developers.google.com/nearby/connections/android/get-started
- Nearby Connections strategies (Star = one hub, N spokes):
  https://developers.google.com/nearby/connections/strategies
- Android local network permission (Android 17, target SDK 37):
  https://developer.android.com/privacy-and-security/local-network-permission
- Nearby Wi-Fi devices permission:
  https://developer.android.com/develop/connectivity/wifi/wifi-permissions

Capacitor plugins (versions and dates from the npm registry)

- `capacitor-websocket-server`: https://github.com/raghu2x/capacitor-websocket-server
- `@cantoo/capacitor-http-server`: https://github.com/cantoo-scribe/capacitor-http-server
- `@capgo/capacitor-bluetooth-low-energy`: https://github.com/Cap-go/capacitor-bluetooth-low-energy
- `@capacitor-community/bluetooth-le`: https://github.com/capacitor-community/bluetooth-le
- Capawesome Bluetooth Low Energy: https://capawesome.io/plugins/bluetooth-low-energy
- `@enertrag/p2pconnect`: https://github.com/enertrag/p2pconnect
- `@squareetlabs/capacitor-nearby-multipeer`: https://github.com/squareetlabs/capacitor-nearby-multipeer
- `capacitor-nearby-plugin`: https://github.com/xettrialeen/capacitor-nearby-plugin
- `capacitor-zeroconf`: https://github.com/trik/capacitor-zeroconf
- `@capacitor/barcode-scanner`: https://github.com/ionic-team/capacitor-barcode-scanner
- `@capacitor-mlkit/barcode-scanning`: https://github.com/capawesome-team/capacitor-mlkit
- `@capacitor-community/keep-awake`: https://www.npmjs.com/package/@capacitor-community/keep-awake
- `qrcode-generator`: https://github.com/kazuhikoarase/qrcode-generator

Not verified from a primary source, stated from general knowledge: NanoHTTPD's maintenance state,
the Nearby BYTES payload size limit, `BarcodeDetector` availability on Windows, Bluetooth tethering
giving a usable IP link without mobile data, and the location-services requirement on Android 12 and
older.
