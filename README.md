# vbox-replay-web — browser edition of a sim-racing telemetry client (study)

Runs the web bundle of an Electron-based sim-racing telemetry desktop client (version 6.4.1) in a normal browser, without Electron, and feeds it real-world Racelogic VBOX data.

## What is (and is not) in this repository

This repo contains only the code written for the study: the Node stand-in server (`server/`), the Electron-bridge shim
(`public/web-shim.js`, `public/web-overrides.css`), the VBOX → `.delta` converter and the OpenStreetMap track-map builder.

The desktop client's own web bundle (`public/dist`, `public/images`, `public/fa`, `public/fonts`), the captured
server-rendered pages (`views/raw`) and all session data, telemetry and video (`data/`) are **not** included and are
git-ignored. They belong to the client's publisher and to the drivers respectively. This project is independent and not
affiliated with or endorsed by that publisher.

## Setup

1. Install the desktop client (6.4.1) and copy its web bundle from the app package into `public/dist/<version>/`, with
   `images/`, `fa/` and `fonts/` alongside (on macOS the bundle is inside the app's `Contents/Resources/app.asar`,
   extract with `npx asar extract`).
2. Capture the server-rendered pages you need into `views/raw/` from your own logged-in session.
3. `npm install && npm start`, then convert a VBOX log with `server/vbo-to-delta.mjs` (below).

### Windows

- The download from GitHub (Code → Download ZIP) contains only the code. You still need step 1 and 2 above.
- Install the desktop client, then find its `resources` folder (the one containing `app.asar`, usually under the install
  directory of the app). Copy the web bundle out with the asar tool. From PowerShell in this project folder:
  `npx asar extract "<install dir>\resources\app.asar" .\_app`, then move `_app\dist` → `public\dist\<version>`, and
  `images`, `fa`, `fonts` → `public\`. Delete `_app` afterwards.
- `data\ellei18n.json` and `data\elledata.json` are also not in the repo (they come from the client's bundle, the same
  as `public\dist`). The server won't start without them. Copy both from a working setup into `data\`, or extract them
  from the same app package as the bundle.
- Install Node.js LTS. Install ffmpeg and make sure `ffmpeg.exe` is on your PATH (or set `FFMPEG=C:\path\ffmpeg.exe`).
  Clip cutting uses `libx264` on Windows (Apple's `h264_videotoolbox` is macOS-only); override with `FFMPEG_ENCODER`.
- Camera files are searched in the folder next to the `.vbo`, `data\vbox`, `%USERPROFILE%\Movies`, `Downloads` and `Videos`.
- Run `npm install` and `npm start` in PowerShell. Open http://localhost:8788.

    npm start            # http://localhost:8788
    npm run build:delta  # re-encode data/*.json sessions into .delta files

How it works
- `public/dist`, `public/images`, `public/fa`, `public/fonts`: the original client bundle, CSS, icons and web fonts.
- `public/web-shim.js`: replaces the Electron preload bridge (`window.ipcRenderer`). Settings live in localStorage.
- `server/`: a small Node server that renders the captured server-side views (`views/raw/*.html`) and stands in
  for the original backend (`/api/*`). Sessions, leaderboards, stats and track maps come from `data/`.
- `server/delta-encode.mjs`: reconstructed `.delta` session file format (length-delimited protobuf).

Local accounts and data: "Log in with Discord" signs you in locally (cookie). The Okayama MX-5 demo session is
pre-loaded as your first session; leaderboard drivers are pseudonymised.
Everything under public/dist, public/images and views/raw is the publisher's work and is used for personal study only.

Real-world data: `node server/vbo-to-delta.mjs <file.vbo> --id <id> --car <code> --car-name "<name>" --track <code> --track-name "<name>" [--type practice|qualification|race]`
converts a Racelogic VBOX log (GPS + ECU channels) into a session and a generated track map, using the
[laptiming] start/finish gate for exact lap splits. Restart the server and the session appears in Session History.

Track maps: after converting, `server/track-map-from-osm.mjs` fetches the circuit's surveyed raceway geometry from
OpenStreetMap (cached in `data/osm/`), map-matches the driven lap to it (heading + continuity, pit lanes excluded),
and writes the road at 0.6 m resolution with tagged widths, the same density the client's own maps use. Where OSM has no
road within 15 m the driven line is used for that stretch. Run it alone with `node server/track-map-from-osm.mjs <sessionId>`.

Projection note: The client draws iRacing GPS as plain degrees x 1e5 with no latitude correction (its own maps come from the
sim's track builder with the same convention). Real-world circuits would be stretched east-west by 1/cos(lat), so the
converter stores longitudes compressed by cos(lat0) (`sessions-meta.json` → `projection`) and the OSM map builder applies
the same transform. Changing a session's geometry means using a new session id: the client caches decoded sessions in IndexedDB
(Settings → "Clear session cache" also works).

Onboard video: a VBOX log names its camera file in `[avi]` (`<prefix><avifileindex>.mp4`) and logs `avitime` per sample.
The converter looks for that file next to the .vbo, then in `data/vbox/`, `~/Movies` and `~/Downloads`, and records the
exact video window of every lap (interpolated at the start/finish crossing). The server answers the client's capture API with a
frame-accurate per-lap clip cut by ffmpeg on first use (`data/cache/`), so the lap's video time 0 is the line crossing,
which is what the client's player assumes. Laps with video show the camera icon in Timing and open the floating player.
`data/vbox/*_0001.mp4` for Zandvoort is a generated stand-in with burned-in timecode (no camera file exists on this Mac);
replace it with the real recording of the same name and reconvert.

Runtime workers: `public/dist/<sig>/frame-cache.worker.js` (WebCodecs frame cache for the video player) and
`telemetry.worker.js` are loaded by the bundle at runtime and must be present; without the frame-cache worker the player
pauses right after play and never shows the volume control. Lap clips are cut at 720p/3 Mbps with AAC audio.
Track maps fall back to the driven corridor of all laps when OpenStreetMap matches loosely (median > 4.5 m or > 2% unmatched).

Coordinate precision: `.delta` stores coordinates as 32-bit floats, which quantises absolute degrees to 0.5–0.9 m (visible
as stair-stepped lines and missed apexes). Sessions therefore store offsets from the session origin (`projection.lat0/lon0`),
with the track map in the same frame (origin 0,0). Corridor-mode roads use the envelope of the racing laps (within 110 % of
the best time, > 40 km/h) with 0.8 m margin and only 2 m smoothing of the reference line, so every racing lap is inside the
drawn road and the best lap touches the inner edge at the apexes.
