# Kudominoes

Cuban-rules double-six partner dominoes (you + CPU partner vs two CPUs). Vite + TypeScript + three.js,
packaged for Android with Capacitor. Spanish (neutral) by default, English in Ajustes.

## Rules ("Cubano clásico" preset = `DEFAULT_RULES`)

Rule settings are data-driven (`src/engine/rules.ts`, `RULE_SETTINGS`); the settings UI renders them generically.

- `rounding: 'up'` — a hand's pips are rounded to the ten and divided by ten (31 → 4, 65 → 7, 0 → 0); also `nearest`, `down`, `none` (raw pips).
- `target: 20` (10/15/20/30) on that scale; with `rounding: 'none'` every tens-scale value (target, bonuses) is ×10 (20 → 200).
- `capicua: 'double'` — round first, then double (65 → 7, ×2 = 14); the order lives in `CAPICUA_DOUBLE_BEFORE_ROUNDING` (`src/engine/scoring.ts`). Fixed +1/+2/+3 also available.
- `paseSalida: 2` + `paseSalidaNoWin: true` — the opening team scores 2 the moment the next player passes on the first ficha (shown at once on the scoreboard); never added if it would reach the target. The match is only ever decided at a hand end.
- `nextStarter: 'winnerTeam'` — from hand 2 the winning pair chooses its opener after the deal (`pendingStarterChoice`, `chooseStarter`); after a void hand the same player opens again.
- `paseCorrido` (triple pass), `chuchazo`, `pollona` are off by default. Cerrado points are rounded like a domino.
- Stored settings carry `rulesVersion`; older rules are migrated (structural choices kept, points scale reset). Old raw-pip saved matches are discarded.

## Characters (CPU players)

"Jugar" opens a table with the four seats and a grid of ten characters (`src/roster.ts`): pick your
partner (seat 2) and the two rivals (seats 1 and 3). Each character has a fixed level, a playing style,
a face (`src/ui/avatars.ts`, composable `FaceSpec`) and a one-line description.

| Level | Characters (style) |
| --- | --- |
| easy | Lola (carefree), Pepe (impulsive), Nico (beginner) |
| normal | Elena (balanced), Andrés (by the book), Rosa (blocker) |
| hard | Carlos (aggressive), Marta (cold calculator), Don Julio (team player) |
| master | Papi Zorg (the perfect player) |

- Styles are light biases on the level's algorithm (`STYLE_WEIGHTS` in `src/engine/ai.ts`; easy styles pick
  their own random/heavy/basic policy) plus how often the character slams (`Character.slam`, used by the controller).
- `master`: time-budgeted (`MASTER_MS` = 170 ms wall clock, under the ~250 ms phone cap) determinized
  simulation with soft hidden-hand inference (leads, exposed suits, doubles a player chose not to play),
  a stronger playout policy, exact alpha-beta once ≤ 11 tiles are left, and match-aware scoring.
- The lineup is stored in settings (`lineup`) and in the save; older settings/saves with per-seat
  `cpuLevels` continue with Carlos / Elena / Andrés.

## Web

```sh
npm install
npm run dev          # dev server on http://localhost:5173 (HMR)
npm test             # engine/layout unit tests (vitest)
npm run build        # type-check + production build into dist/
npm run preview      # serve dist/ locally
```

The production web build registers a small service worker (`public/sw.js`), so the game is
installable and works offline. It is not registered inside the Android app.

Dev-only extras: `?mock=1` swaps in the mock engine/renderer; `/harness.html` is a renderer test bench.

## Android (debug APK)

```sh
npm run android:sync   # web build + npx cap sync android
npm run android:apk    # sync, then gradlew assembleDebug with the local toolchain
```

The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`.
Use `node scripts/android-apk.mjs --no-sync` to rebuild only the native part.

### Toolchain (in `..ndroid-toolchain`, next to the project; nothing installed globally)

`scripts/android-apk.mjs` sets these for every Gradle run (override the root with `KUDO_ANDROID_TOOLCHAIN`):

| Variable | Path |
| --- | --- |
| `JAVA_HOME` | `..\android-toolchain\jdk\jdk-21.0.13+9` |
| `ANDROID_HOME`, `ANDROID_SDK_ROOT` | `..\android-toolchain\sdk` (platforms 35 + 36, build-tools 35) |
| `GRADLE_USER_HOME` | `..\android-toolchain\gradle-home` |
| `ANDROID_USER_HOME` | `..\android-toolchain\android-user-home` |

It also writes `android/local.properties` (`sdk.dir`). Extra SDK packages:
`..\android-toolchain\sdk\cmdline-tools\latest\bin\sdkmanager.bat --sdk_root=..\android-toolchain\sdk "<package>"`.

Capacitor 8 (compileSdk/targetSdk 36, minSdk 24, JDK 21). App id `com.kudominoes.app`.
