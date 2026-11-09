#!/usr/bin/env node
// Builds a Delta track map (centre line, both edges, polygon) from OpenStreetMap raceway geometry,
// guided by a driven GPS lap so the right layout variant and direction are used.
//
//   node server/track-map-from-osm.mjs <sessionId> [--width 12] [--sim iracing]
//
// The OSM response is cached in data/osm/<track>.json. Output: data/trackmap-<sim>-<track>.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeSession } from './delta-encode.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataFile = (n) => path.join(root, 'data', n);
// Only true pit lanes are excluded; layout variants (chicane bypasses, link roads) stay candidates and the
// heading + continuity matching decides whether the driven lap actually used them.
const PIT_RE = /\bpit|boxengasse|bokszutca|paddock|pitlane|pit lane/i;
const M_PER_DEG_LAT = 111320;

export async function fetchRaceways(bbox, cacheName) {
  const cache = dataFile(path.join('osm', cacheName + '.json'));
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const [s, w, n, e] = bbox;
  const q = `[out:json][timeout:120];way["highway"="raceway"](${s},${w},${n},${e});out geom;`;
  const servers = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let lastErr;
  for (const srv of servers) {
    try {
      const r = await fetch(srv, { method: 'POST', headers: { 'User-Agent': 'vbox-replay-web/1.0 (local research)', Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(170000) });
      if (!r.ok) throw new Error(srv + ' HTTP ' + r.status);
      const json = await r.json();
      fs.mkdirSync(path.dirname(cache), { recursive: true }); fs.writeFileSync(cache, JSON.stringify(json));
      return json;
    } catch (err) { lastErr = err; console.warn('overpass:', String(err.message || err)); }
  }
  throw lastErr;
}

const metres = (lat0) => ({ kx: M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180), ky: M_PER_DEG_LAT });

// Densify a lat/lon polyline to ~1 m steps (linear), keeping the way's width tag.
function densify(points, step, k) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const d = Math.hypot((b.lon - a.lon) * k.kx, (b.lat - a.lat) * k.ky);
    const n = Math.max(1, Math.ceil(d / step));
    for (let j = 0; j < n; j++) out.push({ lat: a.lat + ((b.lat - a.lat) * j) / n, lon: a.lon + ((b.lon - a.lon) * j) / n });
  }
  out.push(points[points.length - 1]);
  return out;
}

// Simple grid index for nearest-neighbour lookups in metres.
function gridIndex(pts, k, cell = 20, topN = 1) {
  const g = new Map();
  const key = (p) => `${Math.floor((p.lon * k.kx) / cell)}:${Math.floor((p.lat * k.ky) / cell)}`;
  pts.forEach((p, i) => { const kk = key(p); if (!g.has(kk)) g.set(kk, []); g.get(kk).push(i); });
  return (p, radius) => {
    const cx = Math.floor((p.lon * k.kx) / cell), cy = Math.floor((p.lat * k.ky) / cell), r = Math.ceil(radius / cell);
    const found = [];
    for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) {
      for (const i of g.get(`${x}:${y}`) || []) { const q = pts[i]; const d = Math.hypot((q.lon - p.lon) * k.kx, (q.lat - p.lat) * k.ky); if (d < radius) found.push({ index: i, dist: d }); }
    }
    found.sort((a, b) => a.dist - b.dist);
    // keep the closest point of each distinct way so parallel roads stay distinguishable
    const out = [], seen = new Set();
    for (const f of found) { const w = pts[f.index].way; if (seen.has(w)) continue; seen.add(w); out.push(f); if (out.length >= topN) break; }
    return out;
  };
}

// Centripetal Catmull-Rom resampling of a closed polyline to a fixed step (metres).
function resampleClosed(pts, step, k) {
  const n = pts.length; const out = [];
  const P = (i) => pts[((i % n) + n) % n];
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const segLen = Math.hypot((p2.lon - p1.lon) * k.kx, (p2.lat - p1.lat) * k.ky);
    const steps = Math.max(1, Math.round(segLen / step));
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ lat: f(p0.lat, p1.lat, p2.lat, p3.lat), lon: f(p0.lon, p1.lon, p2.lon, p3.lon), w: p1.w });
    }
  }
  return out;
}
function gaussianClosed(pts, sigma) {
  const r = Math.ceil(sigma * 3), w = []; let sum = 0;
  for (let j = -r; j <= r; j++) { const v = Math.exp(-(j * j) / (2 * sigma * sigma)); w.push(v); sum += v; }
  return pts.map((_, i) => { let lat = 0, lon = 0, ww = 0; for (let j = -r; j <= r; j++) { const p = pts[(i + j + pts.length) % pts.length]; const g = w[j + r] / sum; lat += p.lat * g; lon += p.lon * g; ww += p.w * g; } return { lat, lon, w: ww }; });
}
const smoothClosed = (pts, win) => pts.map((_, i) => { let lat = 0, lon = 0, w = 0; for (let j = -win; j <= win; j++) { const p = pts[(i + j + pts.length) % pts.length]; lat += p.lat; lon += p.lon; w += p.w; } const n = 2 * win + 1; return { lat: lat / n, lon: lon / n, w: w / n }; });

export async function buildTrackMap({ sessionId, sim = 'iracing', defaultWidth = 12, trackCode }) {
  const decoded = decodeSession(fs.readFileSync(dataFile(sessionId + '.delta')));
  const track = trackCode || decoded.session.track;
  const valid = decoded.laps.filter((l) => l.isValid && l.steps.length > 100);
  const lap = (valid.length ? valid : decoded.laps).sort((a, b) => a.lapTime - b.lapTime)[0];
  // Sessions store longitudes compressed by cos(lat0) (see vbo-to-delta.mjs); undo that for matching, redo it on output.
  const metaFile = dataFile('sessions-meta.json');
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8'))[sessionId] : null;
  const projection = meta?.projection || null;
  // stored = offsets from the session origin, longitude compressed by cos(lat0); older sessions stored absolute degrees
  const hasOrigin = projection && Number.isFinite(projection.lat0);
  const trueLon = (lon) => (projection ? (hasOrigin ? projection.lon0 + lon / projection.cosLat : projection.lon0 + (lon - projection.lon0) / projection.cosLat) : lon);
  const trueLat = (lat) => (hasOrigin ? projection.lat0 + lat : lat);
  const storedLon = (lon) => (projection ? (hasOrigin ? (lon - projection.lon0) * projection.cosLat : projection.lon0 + (lon - projection.lon0) * projection.cosLat) : lon);
  const storedLat = (lat) => (hasOrigin ? lat - projection.lat0 : lat);
  const gps = lap.steps.map((s) => ({ lat: trueLat(s.coordinates[0]), lon: trueLon(s.coordinates[1]) })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const lat0 = gps[0].lat, k = metres(lat0);
  const lats = gps.map((p) => p.lat), lons = gps.map((p) => p.lon);
  const pad = 0.004; // ~400 m
  const bbox = [Math.min(...lats) - pad, Math.min(...lons) - pad, Math.max(...lats) + pad, Math.max(...lons) + pad];
  const osm = await fetchRaceways(bbox.map((v) => v.toFixed(5)), `${sim}-${track.replace(/[^a-z0-9]+/gi, '-')}`);
  const ways = osm.elements.filter((e) => e.type === 'way' && e.geometry && !PIT_RE.test(e.tags?.name || '') && !PIT_RE.test(e.tags?.service || '') && e.tags?.sport !== 'karting');
  console.log(`OSM: ${osm.elements.length} raceway ways in bbox, ${ways.length} used (pit lanes, karting and access roads excluded)`);
  // Dense OSM road points with width per way
  const dense = [];
  for (const w of ways) {
    const width = parseFloat(w.tags?.width) || null; const pts = densify(w.geometry, 1, k);
    for (let i = 0; i < pts.length; i++) { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]; const heading = Math.atan2((b.lat - a.lat) * k.ky, (b.lon - a.lon) * k.kx); dense.push({ lat: pts[i].lat, lon: pts[i].lon, w: width, way: w.id, heading }); }
  }
  const nearest = gridIndex(dense, k, 20, 6);
  const angDiff = (a, b) => { let d = Math.abs(a - b) % (2 * Math.PI); d = d > Math.PI ? 2 * Math.PI - d : d; return Math.min(d, Math.PI - d); }; // direction-agnostic
  // Walk the GPS lap (2 m steps) and match each sample to the OSM road: closest point whose road heading agrees
  // with the car's heading and which continues from the previous match. Otherwise keep the GPS point.
  const samples = []; let acc = 0, last = null;
  for (let i = 0; i < gps.length; i++) { const p = gps[i]; if (last) { acc += Math.hypot((p.lon - last.lon) * k.kx, (p.lat - last.lat) * k.ky); if (acc < 2) continue; acc = 0; } last = p; samples.push({ ...p, i }); }
  const gpsHeading = (idx) => { const a = gps[Math.max(0, idx - 8)], b = gps[Math.min(gps.length - 1, idx + 8)]; return Math.atan2((b.lat - a.lat) * k.ky, (b.lon - a.lon) * k.kx); };
  let snapped = []; let offRoad = 0; const dists = []; let prev = null;
  for (const p of samples) {
    const h = gpsHeading(p.i);
    const cands = nearest(p, 15).filter((c) => angDiff(dense[c.index].heading, h) < (40 * Math.PI) / 180);
    let pick = null;
    for (const c of cands) {
      const q = dense[c.index];
      const jump = prev ? Math.hypot((q.lon - prev.lon) * k.kx, (q.lat - prev.lat) * k.ky) : 0;
      if (prev && jump > 10) continue; // a different stretch of road
      const cost = c.dist + (prev ? Math.abs(jump - 2) : 0);
      if (!pick || cost < pick.cost) pick = { q, cost, dist: c.dist };
    }
    if (!pick) { offRoad++; const gp = { lat: p.lat, lon: p.lon, w: null, gps: true }; snapped.push(gp); prev = gp; continue; }
    dists.push(pick.dist);
    const sp = { lat: pick.q.lat, lon: pick.q.lon, w: pick.q.w, gps: false }; snapped.push(sp); prev = sp;
  }
  // de-duplicate consecutive identical snaps and close the loop
  snapped = snapped.filter((p, i) => i === 0 || Math.hypot((p.lon - snapped[i - 1].lon) * k.kx, (p.lat - snapped[i - 1].lat) * k.ky) > 0.3);
  while (snapped.length > 2 && Math.hypot((snapped[0].lon - snapped[snapped.length - 1].lon) * k.kx, (snapped[0].lat - snapped[snapped.length - 1].lat) * k.ky) < 15 && snapped.length > 100) snapped.pop();
  // widths: carry the last known tag forward, default where OSM has none
  let lastW = null; for (const p of snapped) { if (p.w) lastW = p.w; else p.w = lastW || defaultWidth; }
  const gpsShare = snapped.filter((p) => p.gps).length / snapped.length;
  const medianDist = dists.sort((a, b) => a - b)[Math.floor(dists.length / 2)] || 0;
  console.log(`snap: ${snapped.length} points, ${(gpsShare * 100).toFixed(1)}% fell back to GPS, median GPS→centre ${medianDist.toFixed(1)} m, off-road samples ${offRoad}`);
  if (gpsShare > 0.5) throw new Error('Less than half of the lap matched OSM raceway geometry; keeping the GPS-derived map');

  // OSM is only used when it matches the driving tightly. Sparse or offset OSM centre lines (Mandalika: 6 m median,
  // 7% unmatched) produce lumps where the match flips between map and GPS. Otherwise the centre line is built from the
  // laps themselves: the middle of the corridor all laps drive in, which with 10+ laps is the road centre to ~1 m.
  const osmGood = gpsShare < 0.02 && medianDist < 4.5;
  let centre, corridorBuilt = false;
  if (osmGood) {
    centre = smoothClosed(snapped, 2);
    centre = resampleClosed(centre, 0.6, k);
    centre = gaussianClosed(centre, 5); // sigma 3 m: kerb kinks in sparse OSM nodes disappear, geometry moves < 0.5 m
    centre = resampleClosed(centre, 0.6, k);
  } else {
    console.log(`OSM match too loose (median ${medianDist.toFixed(1)} m, ${(gpsShare * 100).toFixed(1)}% unmatched): building the road from the driven corridor of ${valid.length || 1} laps`);
    // Reference: the best lap at 1 m steps with only light smoothing (sigma 2 m, about the GPS noise). Heavier smoothing
    // pulls corners inward and the drawn road no longer sits where the car drove.
    let ref = resampleClosed(gps.map((p) => ({ ...p, w: defaultWidth })), 1, k);
    ref = gaussianClosed(ref, 2); ref = resampleClosed(ref, 1, k);
    const n = ref.length;
    const nrm = ref.map((p, i) => { const a = ref[(i - 2 + n) % n], b = ref[(i + 2) % n]; const dx = (b.lon - a.lon) * k.kx, dy = (b.lat - a.lat) * k.ky, len = Math.hypot(dx, dy) || 1; return { nx: -dy / len, ny: dx / len }; });
    const cell = 10, g2 = new Map(); const key2 = (lat, lon) => `${Math.floor((lon * k.kx) / cell)}:${Math.floor((lat * k.ky) / cell)}`;
    ref.forEach((p, i) => { const kk = key2(p.lat, p.lon); if (!g2.has(kk)) g2.set(kk, []); g2.get(kk).push(i); });
    const nearestRef = (lat, lon) => { const cx = Math.floor((lon * k.kx) / cell), cy = Math.floor((lat * k.ky) / cell); let bi = -1, bd = 1e9; for (let x = cx - 2; x <= cx + 2; x++) for (let y = cy - 2; y <= cy + 2; y++) for (const i of g2.get(`${x}:${y}`) || []) { const q = ref[i]; const d = Math.hypot((q.lon - lon) * k.kx, (q.lat - lat) * k.ky); if (d < bd) { bd = d; bi = i; } } return { index: bi, dist: bd }; };
    // Envelope of the racing laps (within 10% of the best time, racing speed): the road must contain every one of them,
    // so the extremes are kept, not trimmed. Slow laps with excursions do not shape the road.
    const bestTime = lap.lapTime; const racing = (valid.length ? valid : [lap]).filter((l) => l.lapTime <= bestTime * 1.1);
    const lo = new Float64Array(n).fill(NaN), hi = new Float64Array(n).fill(NaN);
    for (const l of racing) for (const st of l.steps) {
      if (st.speed < 40) continue; const latS = trueLat(st.coordinates[0]), lonS = trueLon(st.coordinates[1]); if (!Number.isFinite(latS) || !Number.isFinite(lonS)) continue;
      const { index, dist } = nearestRef(latS, lonS); if (index < 0 || dist > 20) continue;
      const c0 = ref[index], m0 = nrm[index]; const side = ((lonS - c0.lon) * k.kx) * m0.nx + ((latS - c0.lat) * k.ky) * m0.ny;
      if (!(side >= lo[index])) lo[index] = side; if (!(side <= hi[index])) hi[index] = side;
    }
    // close small gaps (<= 10 m) by nearest neighbour, then let each edge be the running extreme over +-3 m and smooth +-4 m
    for (let i = 0; i < n; i++) if (Number.isNaN(lo[i])) { for (let d = 1; d <= 10; d++) { const a = (i - d + n) % n, b = (i + d) % n; if (!Number.isNaN(lo[a])) { lo[i] = lo[a]; hi[i] = hi[a]; break; } if (!Number.isNaN(lo[b])) { lo[i] = lo[b]; hi[i] = hi[b]; break; } } if (Number.isNaN(lo[i])) { lo[i] = -defaultWidth / 2; hi[i] = defaultWidth / 2; } }
    const run = (arr, r, fn) => { const o = new Float64Array(n); for (let i = 0; i < n; i++) { let v = arr[i]; for (let j = -r; j <= r; j++) v = fn(v, arr[(i + j + n) % n]); o[i] = v; } return o; };
    const avg = (arr, r) => { const o = new Float64Array(n); for (let i = 0; i < n; i++) { let acc = 0; for (let j = -r; j <= r; j++) acc += arr[(i + j + n) % n]; o[i] = acc / (2 * r + 1); } return o; };
    const loS = avg(run(lo, 3, Math.min), 4), hiS = avg(run(hi, 3, Math.max), 4);
    const margin = 0.8, minHalf = defaultWidth / 2;
    centre = ref.map((p, i) => { let a = loS[i] - margin, b = hiS[i] + margin; if (b - a < minHalf * 2) { const m = (a + b) / 2; a = m - minHalf; b = m + minHalf; } const mid = (a + b) / 2; return { lat: p.lat + (nrm[i].ny * mid) / k.ky, lon: p.lon + (nrm[i].nx * mid) / k.kx, w: b - a }; });
    centre = resampleClosed(centre, 0.6, k);
    console.log(`corridor: ${racing.length} racing laps (<= 110% of best) define the road edges`);
    corridorBuilt = true;
    centre = gaussianClosed(centre, 4); centre = resampleClosed(centre, 0.6, k);
  }
  // Edges: start from the tagged width, then make sure every driven line (all valid laps) stays on the drawn surface.
  // Drivers use the kerbs, which OSM centre lines and width tags do not include; the sim maps Delta ships include them
  // (Okayama is 11.5–15 m wide). So each side is widened where the laps actually run, plus a small margin.
  const normals = centre.map((p, i) => {
    const a = centre[(i - 3 + centre.length) % centre.length], b = centre[(i + 3) % centre.length];
    const dx = (b.lon - a.lon) * k.kx, dy = (b.lat - a.lat) * k.ky, len = Math.hypot(dx, dy) || 1;
    return { nx: -dy / len, ny: dx / len, tx: dx / len, ty: dy / len };
  });
  const cellM = 10, grid = new Map();
  const gkey = (lat, lon) => `${Math.floor((lon * k.kx) / cellM)}:${Math.floor((lat * k.ky) / cellM)}`;
  centre.forEach((p, i) => { const kk = gkey(p.lat, p.lon); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push(i); });
  const nearestCentre = (lat, lon) => { const cx = Math.floor((lon * k.kx) / cellM), cy = Math.floor((lat * k.ky) / cellM); let bi = -1, bd = 1e9; for (let x = cx - 2; x <= cx + 2; x++) for (let y = cy - 2; y <= cy + 2; y++) for (const i of grid.get(`${x}:${y}`) || []) { const q = centre[i]; const d = Math.hypot((q.lon - lon) * k.kx, (q.lat - lat) * k.ky); if (d < bd) { bd = d; bi = i; } } return { index: bi, dist: bd }; };
  const extraLeft = new Float64Array(centre.length), extraRight = new Float64Array(centre.length);
  let driven = 0;
  for (const l of (valid.length ? valid : [lap])) for (const st of l.steps) {
    const latS = trueLat(st.coordinates[0]), lonS = trueLon(st.coordinates[1]); if (!Number.isFinite(latS) || !Number.isFinite(lonS)) continue;
    const { index, dist } = nearestCentre(latS, lonS); if (index < 0 || dist > 25) continue;
    const c0 = centre[index], n = normals[index];
    const side = ((lonS - c0.lon) * k.kx) * n.nx + ((latS - c0.lat) * k.ky) * n.ny; // +left / -right of travel
    const half = c0.w / 2, margin = 1.0;
    if (corridorBuilt) { driven++; continue; }
    if (side > 0) extraLeft[index] = Math.max(extraLeft[index], side + margin - half); else extraRight[index] = Math.max(extraRight[index], -side + margin - half);
    driven++;
  }
  // spread and smooth the widening along the track (window ±12 m), cap it at 5 m per side
  const spread = (arr) => { const n = arr.length, r = 20, out = new Float64Array(n); for (let i = 0; i < n; i++) { let m = 0; for (let j = -r; j <= r; j++) m = Math.max(m, arr[(i + j + n) % n]); out[i] = Math.min(5, m); } const sm = new Float64Array(n); for (let i = 0; i < n; i++) { let acc = 0; for (let j = -r; j <= r; j++) acc += out[(i + j + n) % n]; sm[i] = acc / (2 * r + 1); } return sm; };
  const widenL = spread(extraLeft), widenR = spread(extraRight);
  const left = [], right = [];
  for (let i = 0; i < centre.length; i++) {
    const p = centre[i], n = normals[i], hl = p.w / 2 + widenL[i], hr = p.w / 2 + widenR[i];
    left.push({ lat: p.lat + (n.ny * hl) / k.ky, lon: p.lon + (n.nx * hl) / k.kx });
    right.push({ lat: p.lat - (n.ny * hr) / k.ky, lon: p.lon - (n.nx * hr) / k.kx });
  }
  const totalW = centre.map((p, i) => p.w + widenL[i] + widenR[i]);
  console.log(`surface: ${driven} driven samples from ${valid.length || 1} laps; road ${Math.min(...totalW).toFixed(1)}–${Math.max(...totalW).toFixed(1)} m wide incl. kerbs`);
  // Project into Delta's iRacing map space: x = -(lon - originLng) * 1e5, y = (lat - originLat) * 1e5
  const originLat = lap.steps[0].coordinates[0], originLng = lap.steps[0].coordinates[1]; // in the stored frame
  const proj = (p) => ({ x: -(storedLon(p.lon) - originLng) * 1e5, y: (storedLat(p.lat) - originLat) * 1e5 });
  const f3 = (n) => n.toFixed(3);
  const pathD = (arr) => 'M' + arr.map(proj).map((p) => `${f3(p.x)},${f3(p.y)}`).join(' L') + ' Z';
  const sy = 0.64, sx = projection ? 0.64 : 0.64 * (k.kx / k.ky);
  const xs = centre.map(proj).map((p) => p.x), ys = centre.map(proj).map((p) => p.y);
  const e = -Math.min(...xs) * sx + 60, f = -Math.min(...ys) * sy + 60;
  const g = (inner) => `<svg><g transform="matrix(${sx.toFixed(4)} 0 0 ${sy} ${e.toFixed(2)} ${f.toFixed(2)})" style="transform: matrix(${sx.toFixed(4)}, 0, 0, ${sy}, ${e.toFixed(2)}, ${f.toFixed(2)});">${inner}</g></svg>`;
  const edge = (d) => `<path class="track-edge" stroke="#5D6496" stroke-width="1" fill="none" d="${d}"></path>`;
  const now = new Date().toISOString();
  const widths = totalW;
  const trackMap = { code: 200, messages: [], meta: [], data: [{ id: Date.now() % 1e6, createdAt: now, updatedAt: now, sim, trackID: track, source: corridorBuilt ? 'driven-corridor' : 'openstreetmap',
    centerSVG: g(edge(pathD(centre))), fullSVG: g(edge(pathD(left)) + edge(pathD(right))),
    polygonSVG: `<svg xmlns="http://www.w3.org/2000/svg"><polygon points="${left.concat(right.slice().reverse()).map(proj).map((p) => `${f3(p.x)},${f3(p.y)}`).join(' ')}" class="track-combined"/></svg>`,
    originLat, originLng }] };
  const out = dataFile(`trackmap-${sim}-${track.replace(/[^a-z0-9]+/gi, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify(trackMap));
  const lengthM = centre.length * 0.6;
  console.log(`wrote ${path.relative(root, out)}: ${centre.length} centre points (0.6 m), length ${(lengthM / 1000).toFixed(3)} km, width ${Math.min(...widths).toFixed(1)}–${Math.max(...widths).toFixed(1)} m`);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const id = args.find((a) => !a.startsWith('--'));
  const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  if (!id) { console.error('usage: track-map-from-osm.mjs <sessionId> [--width 12] [--sim iracing]'); process.exit(1); }
  buildTrackMap({ sessionId: id, sim: opt('sim', 'iracing'), defaultWidth: Number(opt('width', 12)) }).catch((err) => { console.error(err.message || err); process.exit(1); });
}
