#!/usr/bin/env node
// Converts a Racelogic VBOX .vbo log into a .delta session file plus a track map.
//
//   node server/vbo-to-delta.mjs <file.vbo> --id zandvoort-513 --car "porsche 992 cup" --car-name "Porsche 911 GT3 Cup (992)"
//        --track zandvoort --track-name "Circuit Zandvoort" [--type practice] [--sim iracing] [--sectors 3]
//
// Output: data/<id>.delta, data/trackmap-<sim>-<track>.json, names in data/names.json. The server picks them up on restart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeSession } from './delta-encode.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
if (!file) { console.error('usage: vbo-to-delta.mjs <file.vbo> --id <id> --car <code> --track <code> [--car-name ..] [--track-name ..] [--type practice] [--sim iracing] [--sectors 3]'); process.exit(1); }
const id = opt('id', path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, '-'));
const sim = opt('sim', 'iracing'), car = opt('car', 'vbox car'), track = opt('track', 'vbox track'), sessionType = opt('type', 'practice');
const sectorCount = Number(opt('sectors', 3));

// ---- parse --------------------------------------------------------------------------------------
const text = fs.readFileSync(file, 'latin1');
const sections = {}; let cur = null;
for (const line of text.split(/\r?\n/)) {
  const s = line.trim();
  if (/^\[.*\]$/.test(s)) { cur = s.slice(1, -1).toLowerCase(); sections[cur] = []; continue; }
  if (cur && s) sections[cur].push(s);
}
const cols = sections['column names'][0].split(/\s+/);
const ix = Object.fromEntries(cols.map((c, i) => [c, i]));
const pick = (...names) => { for (const n of names) if (n in ix) return ix[n]; return -1; };
const C = {
  time: pick('time'), lat: pick('lat'), lon: pick('long'), v: pick('velocity'), h: pick('height'),
  lapNo: pick('lap_number', 'External_Lap_Number', 'Lap_Number'), lapTime: pick('lap_time', 'External_Lap_Time', 'Lap_Time'),
  throttle: pick('ecu_ath', 'Throttle_Position', 'ecu_aps', 'throttle'), brake: pick('log_pbrake_f', 'Brake_Pressure', 'log_pbrake_r', 'brake'),
  gear: pick('ecu_gear', 'Gear', 'ecu_tgear', 'gear'), rpm: pick('RPM', 'ecu_nmot', 'Engine_Speed', 'rpm'), steer: pick('log_asteer', 'Steering_Angle', 'steer'),
  fuel: pick('log_fuellevel_catch', 'fuel_level', 'fuel'), air: pick('ecu_tint', 'air_temp'),
  aviIndex: pick('avifileindex'), aviTime: pick('avitime'),
  tFL: pick('tpms_temp_fl'), tFR: pick('tpms_temp_fr'), tRL: pick('tpms_temp_rl'), tRR: pick('tpms_temp_rr'),
  pFL: pick('tpms_press_fl'), pFR: pick('tpms_press_fr'), pRL: pick('tpms_press_rl'), pRR: pick('tpms_press_rr'),
};
const num = (r, i) => (i < 0 ? NaN : parseFloat(r[i]));
const rows = sections.data.map((l) => l.split(/\s+/)).filter((r) => r.length >= 8);
const timeToSec = (t) => { const h = Math.floor(t / 10000), m = Math.floor((t % 10000) / 100), s = t % 100; return h * 3600 + m * 60 + s; };
const samples = rows.map((r) => ({
  t: timeToSec(num(r, C.time)),
  lat: num(r, C.lat) / 60, lon: -num(r, C.lon) / 60, alt: num(r, C.h), speed: num(r, C.v),
  lapNo: num(r, C.lapNo), lapTime: num(r, C.lapTime),
  throttle: num(r, C.throttle), brake: num(r, C.brake), gear: num(r, C.gear), rpm: num(r, C.rpm), steer: num(r, C.steer), fuel: num(r, C.fuel), air: num(r, C.air),
  temps: [C.tFL, C.tFR, C.tRL, C.tRR].map((i) => num(r, i)), press: [C.pFL, C.pFR, C.pRL, C.pRR].map((i) => num(r, i)),
  aviIndex: C.aviIndex >= 0 ? r[C.aviIndex] : null, aviTime: num(r, C.aviTime),
})).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && Math.abs(s.lat) > 0.01);
// Midnight rollover
for (let i = 1; i < samples.length; i++) if (samples[i].t < samples[i - 1].t - 1000) for (let j = i; j < samples.length; j++) samples[j].t += 86400;
console.log(`${path.basename(file)}: ${samples.length} samples, channels:`, Object.entries(C).filter(([, v]) => v >= 0).map(([k]) => k).join(' '));

// ---- split into laps ----------------------------------------------------------------------------
// Preferred: the [laptiming] start/finish gate, crossed geometrically and interpolated between samples
// (CAN lap counters update at 5 Hz, which would round lap times to 0.2 s). Fallback: the lap counter channel.
const hasLapChannel = C.lapNo >= 0 && new Set(samples.map((s) => s.lapNo).filter(Number.isFinite)).size > 1;
let segments = []; let crossings = []; // crossings[i] = exact time the segment i started (gate crossing)
const lt = (sections.laptiming || []).find((l) => /^start/i.test(l));
let gate = null, dir = null;
if (lt) {
  // "Start lon1 lat1 lon2 lat2": a point on the line and a second point along the direction of travel.
  const n = lt.replace(/[^\d.+\- ]/g, ' ').trim().split(/\s+/).map(Number);
  gate = { lon: -n[0] / 60, lat: n[1] / 60 }; dir = { lon: -n[2] / 60 - -n[0] / 60, lat: n[3] / 60 - n[1] / 60 };
  const kx0 = 111320 * Math.cos(gate.lat * Math.PI / 180);
  const nearestM = Math.min(...samples.filter((_, i) => i % 25 === 0).map((p) => Math.hypot((p.lon - gate.lon) * kx0, (p.lat - gate.lat) * 111320)));
  if (nearestM > 500) { console.warn(`[laptiming] gate is ${(nearestM / 1000).toFixed(0)} km from the data (stale circuit in the logger); deriving the gate from the lap counter`); gate = null; }
}
if (!gate && hasLapChannel) {
  // Build a start/finish gate from where the lap counter increments: median position and heading of those samples.
  const hits = [];
  for (let i = 5; i < samples.length - 5; i++) if (samples[i].lapNo !== samples[i - 1].lapNo && samples[i].speed > 20) { const a = samples[i - 5], b = samples[i + 5]; hits.push({ lat: samples[i].lat, lon: samples[i].lon, dlat: b.lat - a.lat, dlon: b.lon - a.lon }); }
  if (hits.length) {
    const med = (arr) => { const v = arr.slice().sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
    gate = { lat: med(hits.map((h) => h.lat)), lon: med(hits.map((h) => h.lon)) }; dir = { lat: med(hits.map((h) => h.dlat)), lon: med(hits.map((h) => h.dlon)) };
    console.log(`gate from lap counter: ${hits.length} crossings, at ${gate.lat.toFixed(6)}, ${gate.lon.toFixed(6)}`);
  }
}
if (gate) {
  const kx = 111320 * Math.cos(gate.lat * Math.PI / 180), ky = 111320;
  const along = (p) => ((p.lon - gate.lon) * kx) * (dir.lon * kx) + ((p.lat - gate.lat) * ky) * (dir.lat * ky);
  const nearGate = (p) => Math.hypot((p.lon - gate.lon) * kx, (p.lat - gate.lat) * ky) < 40;
  let start = 0, lastCross = -1e9;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (!nearGate(b)) continue;
    const da = along(a), db = along(b);
    if ((da >= 0) !== (db >= 0) && b.t - lastCross > 20) {
      const frac = da / (da - db); const tCross = a.t + frac * (b.t - a.t);
      segments.push(samples.slice(start, i)); crossings.push(tCross); start = i; lastCross = tCross;
    }
  }
  segments.push(samples.slice(start));
  crossings.unshift(samples[0].t); // the out lap starts when logging starts
}
if (segments.length < 2 && hasLapChannel) {
  segments = []; crossings = []; let start = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i].lapNo !== samples[i - 1].lapNo) { segments.push(samples.slice(start, i)); crossings.push(samples[start].t); start = i; }
  segments.push(samples.slice(start)); crossings.push(samples[start].t);
}
if (segments.length < 2) throw new Error('Could not split the log into laps (no usable [laptiming] gate or lap counter)');
const keep = segments.map((s) => s.length > 20); segments = segments.filter((_, i) => keep[i]); crossings = crossings.filter((_, i) => keep[i]);

const dist = (a, b) => Math.hypot((b.lon - a.lon) * 111320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180), (b.lat - a.lat) * 111320);
const segLength = (seg) => seg.reduce((d, s, i) => (i ? d + dist(seg[i - 1], s) : 0), 0);
const lengths = segments.map(segLength);
// A complete lap is one whose driven length is close to the median of the inner laps (GPS glitches or a missed
// gate crossing can make one segment two laps long; the median is immune to that).
const inner = lengths.slice(1, -1).sort((a, b) => a - b);
const medianLength = inner.length ? inner[Math.floor(inner.length / 2)] : Math.max(...lengths);
const isCompleteLength = (l) => Math.abs(l - medianLength) / medianLength < 0.12;
const fullLength = medianLength;
const lapLength = (() => { const complete = lengths.filter(isCompleteLength); return complete.reduce((a, b) => a + b, 0) / complete.length; })();

// Delta draws iRacing GPS as x = (lon - lon0) * 1e5, y = (lat - lat0) * 1e5 with no latitude correction, so a real
// circuit would be stretched east-west by 1/cos(lat) (1.64x at Zandvoort). Store longitudes pre-compressed by cos(lat0)
// so the map is isotropic; the track-map builder applies the same transform.
// The .delta format keeps coordinates as 32-bit floats: absolute degrees quantise to ~0.5–0.9 m. Storing offsets from the
// session origin (lat0, lon0) keeps millimetre precision; the track map uses the same frame (origin 0,0).
const lat0 = samples[0].lat, lon0 = samples[0].lon, cosLat = Math.cos((lat0 * Math.PI) / 180);
const storedLon = (lon) => (lon - lon0) * cosLat;
const storedLat = (lat) => lat - lat0;
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
// Brake pressure sensors read a residual 1–3 bar when the pedal is released; remove that offset so straights show no braking.
const brakeSorted = samples.map((s) => s.brake).filter(Number.isFinite).sort((a, b) => a - b);
const brakeIdle = brakeSorted.length ? brakeSorted[Math.floor(brakeSorted.length * 0.3)] : 0; // the pedal is released most of the lap
const brakeMax = brakeSorted.length ? (brakeSorted[Math.floor(brakeSorted.length * 0.98)] || 1) - brakeIdle : 1;
const brakeNorm = (v) => { const x = (fin(v) - brakeIdle) / brakeMax; return x < 0.03 ? 0 : Math.min(1, x); };
const throttleMax = Math.max(1, ...samples.map((s) => s.throttle).filter(Number.isFinite)) > 1.5 ? 100 : 1;
const steerMax = Math.max(1, ...samples.map((s) => Math.abs(s.steer)).filter(Number.isFinite));

const videoWindows = {};
const laps = segments.map((seg, idx) => {
  const t0 = crossings[idx] ?? seg[0].t; const tEnd = crossings[idx + 1] ?? seg[seg.length - 1].t; let d = 0;
  const complete = isCompleteLength(segLength(seg));
  // A VBOX log starts and ends mid-lap: the first segment is the out lap, the last the in lap.
  const isOutlap = idx === 0, isInlap = idx === segments.length - 1 && segments.length > 1;
  const steps = seg.map((s, i) => {
    if (i) d += dist(seg[i - 1], s);
    return {
      steering: fin(s.steer) * (Math.PI / 180), throttle: (() => { const t = Math.min(1, Math.max(0, fin(s.throttle) / throttleMax)); return t >= 0.98 ? 1 : t; })(), brake: brakeNorm(s.brake),
      speed: fin(s.speed), tyreTemps: s.temps.every(Number.isFinite) ? s.temps : [], tyrePressures: s.press.every(Number.isFinite) ? s.press.map((p) => p * 14.5038) : [],
      gear: Math.max(0, Math.round(fin(s.gear))), rpm: Math.round(fin(s.rpm)), trackPct: Math.min(0.9999, d / lapLength),
      stopwatch: Math.round((s.t - t0) * 1000), fuel: fin(s.fuel), coordinates: [storedLat(s.lat), storedLon(s.lon), fin(s.alt)],
    };
  });
  // Delta draws one coloured segment per telemetry step; sims deliver 60 Hz, VBOX logs 10–25 Hz. Interpolate to 60 Hz
  // so the throttle/brake lines on the map are as dense as the sim's.
  const TARGET_MS = 1000 / 60;
  const lerp = (a, b, f) => a + (b - a) * f;
  const upsampled = [];
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i], b = steps[i + 1];
    upsampled.push(a);
    if (!b) break;
    const n = Math.round((b.stopwatch - a.stopwatch) / TARGET_MS);
    for (let j = 1; j < n; j++) {
      const f = j / n;
      upsampled.push({
        steering: lerp(a.steering, b.steering, f), throttle: lerp(a.throttle, b.throttle, f), brake: lerp(a.brake, b.brake, f), speed: lerp(a.speed, b.speed, f),
        tyreTemps: a.tyreTemps.map((v, k) => lerp(v, b.tyreTemps[k] ?? v, f)), tyrePressures: a.tyrePressures.map((v, k) => lerp(v, b.tyrePressures[k] ?? v, f)),
        gear: f < 0.5 ? a.gear : b.gear, rpm: Math.round(lerp(a.rpm, b.rpm, f)), trackPct: lerp(a.trackPct, b.trackPct, f),
        stopwatch: Math.round(lerp(a.stopwatch, b.stopwatch, f)), fuel: lerp(a.fuel, b.fuel, f),
        coordinates: [lerp(a.coordinates[0], b.coordinates[0], f), lerp(a.coordinates[1], b.coordinates[1], f), lerp(a.coordinates[2], b.coordinates[2], f)],
      });
    }
  }
  steps.splice(0, steps.length, ...upsampled);
  const lapTime = Math.round((tEnd - t0) * 1000);
  const sectorTimes = []; let last = 0;
  if (complete) { for (let k = 1; k <= sectorCount; k++) { const target = k / sectorCount; const st = k === sectorCount ? steps[steps.length - 1] : steps.find((x) => x.trackPct >= target) || steps[steps.length - 1]; const t = k === sectorCount ? lapTime : st.stopwatch; sectorTimes.push(t - last); last = t; } }
  else sectorTimes.push(lapTime);
  const air = seg.map((s) => s.air).filter(Number.isFinite); const airTemp = air.length ? air.reduce((a, b) => a + b, 0) / air.length : 0;
  const fuelStart = fin(seg[0].fuel), fuelEnd = fin(seg[seg.length - 1].fuel);
  // video sync: ms into the camera file at the lap's start and end
  const aviAt = (t) => { const i = samples.findIndex((x) => x.t >= t); if (i < 0 || !Number.isFinite(samples[i].aviTime)) return null; const a = samples[Math.max(0, i - 1)], b = samples[i]; if (!Number.isFinite(a.aviTime) || b.t === a.t) return { ms: b.aviTime, file: b.aviIndex }; const f = (t - a.t) / (b.t - a.t); return { ms: a.aviTime + (b.aviTime - a.aviTime) * f, file: b.aviIndex }; };
  const vs = aviAt(t0), ve = aviAt(tEnd);
  videoWindows[idx + 1] = vs && ve && vs.file === ve.file ? { file: vs.file, startMs: Math.round(vs.ms), endMs: Math.round(ve.ms) } : null;
  return { lapNumber: idx + 1, trackTemp: airTemp, airTemp, rainIntensity: 0, lapTime, steps, isValid: complete && !isOutlap && !isInlap, isInlap, isOutlap, fuelLevel: fuelEnd, fuelUsage: fuelStart - fuelEnd, sectorTimes };
});
const best = laps.filter((l) => l.isValid).sort((a, b) => a.lapTime - b.lapTime)[0];
console.log(`laps: ${laps.length}, valid ${laps.filter((l) => l.isValid).length}, best ${best ? (best.lapTime / 1000).toFixed(3) : '-'} s, lap length ~${Math.round(lapLength)} m, brake idle ${brakeIdle.toFixed(1)} + max ${brakeMax.toFixed(1)}`);

// ---- session timestamp ----------------------------------------------------------------------------
let timestamp = new Date().toISOString();
const avi = (sections.avi || [])[0] || '';
const m = avi.match(/(20\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d{4}_?$/) || path.basename(file).match(/(20\d{2})[-_]?(\d{2})[-_]?(\d{2})[-_]?(\d{2})(\d{2})(\d{2})/);
if (m) timestamp = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();

// ---- write .delta --------------------------------------------------------------------------------
const session = { car, track, sessionType, fileVersion: 1, sim };
const buf = encodeSession({ session, laps });
fs.writeFileSync(path.join(root, 'data', id + '.delta'), buf);
const metaFile = path.join(root, 'data', 'sessions-meta.json');
const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
// Camera file: VBOX names it <[avi] prefix><avifileindex>.<ext>; look next to the .vbo, then in data/vbox and ~/Movies.
const aviPrefix = (sections.avi || [])[0] || '', aviExt = (sections.avi || [])[1] || 'mp4';
const videoFiles = {};
if (aviPrefix) {
  const dirs = [path.dirname(path.resolve(file)), path.join(root, 'data', 'vbox'), path.join(process.env.HOME || '', 'Movies'), path.join(process.env.HOME || '', 'Downloads')];
  for (const idx of new Set(Object.values(videoWindows).filter(Boolean).map((w) => w.file))) {
    for (const dir of dirs) {
      for (const ext of [aviExt, aviExt.toUpperCase(), 'mp4', 'MP4', 'avi']) {
        const cand = path.join(dir, `${aviPrefix}${idx}.${ext}`);
        if (fs.existsSync(cand) && fs.statSync(cand).size > 1e6) { videoFiles[idx] = cand; break; }
      }
      if (videoFiles[idx]) break;
    }
  }
}
const video = aviPrefix ? { prefix: aviPrefix, ext: aviExt, files: videoFiles, laps: videoWindows } : null;
console.log(video && Object.keys(videoFiles).length ? `video: found ${Object.values(videoFiles).join(', ')}` : `video: no camera file found for ${aviPrefix || '(no [avi] section)'}`);
meta[id] = { timestamp, source: path.basename(file), projection: { lat0, lon0, cosLat }, video };
fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1));
const namesFile = path.join(root, 'data', 'names.json');
const names = fs.existsSync(namesFile) ? JSON.parse(fs.readFileSync(namesFile, 'utf8')) : { cars: {}, tracks: {} };
names.cars[car] = opt('car-name', names.cars[car] || car); names.tracks[track] = opt('track-name', names.tracks[track] || track);
fs.writeFileSync(namesFile, JSON.stringify(names, null, 1));
console.log(`wrote data/${id}.delta (${buf.length} bytes), timestamp ${timestamp}`);

// ---- track map from the best lap ------------------------------------------------------------------
// Delta projects iRacing GPS as x = -(lon - originLng) * 1e5, y = (lat - originLat) * 1e5 and draws telemetry
// inside the map's <g>, so the map must use the same units. The <g> matrix makes the result isotropic.
const ref = best || laps.find((l) => segLength(segments[laps.indexOf(l)]) > fullLength * 0.9) || laps[0];
const originLat = ref.steps[0].coordinates[0], originLng = ref.steps[0].coordinates[1];
const proj = (c) => ({ x: -(c[1] - originLng) * 1e5, y: (c[0] - originLat) * 1e5 });
const mPerUnitX = 111320 / 1e5, mPerUnitY = 111320 / 1e5; // longitudes are stored cos(lat)-compressed
// Resample centre line every ~4 m and lightly smooth it
const pts = []; let acc = 0;
for (let i = 0; i < ref.steps.length; i++) { const c = ref.steps[i].coordinates; const p = proj(c); if (!pts.length) { pts.push(p); continue; } const q = pts[pts.length - 1]; const dm = Math.hypot((p.x - q.x) * mPerUnitX, (p.y - q.y) * mPerUnitY); acc += dm; if (acc >= 4) { pts.push(p); acc = 0; } }
const smooth = pts.map((p, i) => { const a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length]; return { x: (a.x + 2 * p.x + b.x) / 4, y: (a.y + 2 * p.y + b.y) / 4 }; });
const halfWidth = Number(opt('width', 12)) / 2;
const left = [], right = [];
for (let i = 0; i < smooth.length; i++) {
  const a = smooth[(i - 1 + smooth.length) % smooth.length], b = smooth[(i + 1) % smooth.length], p = smooth[i];
  const dx = (b.x - a.x) * mPerUnitX, dy = (b.y - a.y) * mPerUnitY, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len; // unit normal in metres
  left.push({ x: p.x + (nx * halfWidth) / mPerUnitX, y: p.y + (ny * halfWidth) / mPerUnitY });
  right.push({ x: p.x - (nx * halfWidth) / mPerUnitX, y: p.y - (ny * halfWidth) / mPerUnitY });
}
const f3 = (n) => n.toFixed(3);
const pathD = (arr) => 'M' + arr.map((p) => `${f3(p.x)},${f3(p.y)}`).join(' L') + ' Z';
const sy = 0.64, sx = sy * (mPerUnitX / mPerUnitY); // isotropic on screen
const xs = smooth.map((p) => p.x), ys = smooth.map((p) => p.y);
const e = -Math.min(...xs) * sx + 60, f = -Math.min(...ys) * sy + 60;
const g = (inner) => `<svg><g transform="matrix(${sx.toFixed(4)} 0 0 ${sy} ${e.toFixed(2)} ${f.toFixed(2)})" style="transform: matrix(${sx.toFixed(4)}, 0, 0, ${sy}, ${e.toFixed(2)}, ${f.toFixed(2)});">${inner}</g></svg>`;
const edge = (d) => `<path class="track-edge" stroke="#5D6496" stroke-width="1" fill="none" d="${d}"></path>`;
const trackMap = {
  code: 200, messages: [], meta: [],
  data: [{ id: Date.now() % 1e6, createdAt: timestamp, updatedAt: timestamp, sim, trackID: track,
    centerSVG: g(edge(pathD(smooth))), fullSVG: g(edge(pathD(left)) + edge(pathD(right))),
    polygonSVG: `<svg xmlns="http://www.w3.org/2000/svg"><polygon points="${left.concat(right.slice().reverse()).map((p) => `${f3(p.x)},${f3(p.y)}`).join(' ')}" class="track-combined"/></svg>`,
    originLat, originLng }],
};
const tmFile = path.join(root, 'data', `trackmap-${sim}-${track.replace(/[^a-z0-9]+/gi, '-')}.json`);
fs.writeFileSync(tmFile, JSON.stringify(trackMap));
console.log(`wrote ${path.relative(root, tmFile)} (${smooth.length} centre points, origin ${originLat.toFixed(5)}, ${originLng.toFixed(5)})`);

// ---- prefer the surveyed road from OpenStreetMap over the GPS-derived outline ---------------------
try {
  const { buildTrackMap } = await import('./track-map-from-osm.mjs');
  await buildTrackMap({ sessionId: id, sim, defaultWidth: Number(opt('width', 12)), trackCode: track });
} catch (err) {
  console.warn('OSM track map not available, keeping the GPS-derived map:', err.message || err);
}
