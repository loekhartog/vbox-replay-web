// Page routes and the local stand-in for the Delta backend API.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, raw, baseConfig } from './views.mjs';
import { decodeSession, encodeSession } from './delta-encode.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataFile = (n) => path.join(root, 'data', n);
const readJson = (n) => JSON.parse(fs.readFileSync(dataFile(n), 'utf8'));
const user = readJson('user.json');
const COOKIE = 'delta_web_session';

// ---- onboard video: per-lap clips cut from the VBOX camera file -----------------------------------
const sessionMeta = () => (fs.existsSync(dataFile('sessions-meta.json')) ? JSON.parse(fs.readFileSync(dataFile('sessions-meta.json'), 'utf8')) : {});
function lapVideo(id, lapNumber) {
  const v = sessionMeta()[id]?.video; if (!v) return null;
  const w = v.laps?.[lapNumber]; if (!w) return null;
  const src = v.files?.[w.file]; if (!src || !fs.existsSync(src)) return null;
  return { src, startMs: w.startMs, endMs: w.endMs };
}
const clipJobs = new Map();
function lapClip(id, lapNumber) {
  const v = lapVideo(id, lapNumber); if (!v) return Promise.resolve(null);
  const dir = dataFile('cache'); fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${id}-lap-${lapNumber}.mp4`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return Promise.resolve(out);
  if (clipJobs.has(out)) return clipJobs.get(out);
  // Frame-accurate cut (re-encoded) so video time 0 is exactly the start/finish crossing. Delta maps lap time onto video duration.
  const dur = ((v.endMs - v.startMs) / 1000).toFixed(3);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', (v.startMs / 1000).toFixed(3), '-t', dur, '-i', v.src, '-vf', 'scale=-2:720', '-c:v', 'h264_videotoolbox', '-b:v', '3000k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out + '.part.mp4'];
  const job = new Promise((resolve) => {
    const ff = spawn(process.env.FFMPEG || 'ffmpeg', args);
    let err = ''; ff.stderr.on('data', (d) => (err += d));
    ff.on('close', (code) => { clipJobs.delete(out); if (code === 0) { fs.renameSync(out + '.part.mp4', out); resolve(out); } else { console.error('ffmpeg failed', code, err.slice(0, 300)); resolve(null); } });
    ff.on('error', (e) => { clipJobs.delete(out); console.error('ffmpeg not available:', e.message); resolve(null); });
  });
  clipJobs.set(out, job); return job;
}
const bestLapNumber = (s) => s.bestLapNumber || 0;

// ---- local session store (the user's saved sessions) ---------------------------------------
// Every data/*.delta file (except the bundled reference lap) is a saved session. Summaries are cached.
const sessionsDbFile = dataFile('sessions-db.json');
const metaFile = dataFile('sessions-meta.json');
function sessionSummary(id, decoded, timestamp) {
  const laps = decoded.laps.filter((l) => l.isValid && !l.isInlap && !l.isOutlap && l.lapTime > 0);
  const best = laps.reduce((a, l) => (!a || l.lapTime < a.lapTime ? l : a), null);
  const avg = laps.length ? Math.round(laps.reduce((s, l) => s + l.lapTime, 0) / laps.length) : 0;
  const driveTime = decoded.laps.reduce((s, l) => s + (l.lapTime || 0), 0);
  return { id, timestamp, sim: decoded.session.sim, car: decoded.session.car, track: decoded.session.track, sessionType: decoded.session.sessionType,
    laps: decoded.laps.length, validLaps: laps.length, best: best ? best.lapTime : 0, bestLapNumber: best ? best.lapNumber : 0, avg, driveTime, hasCapture: !!(best && lapVideo(id, best.lapNumber)), file: id + '.delta',
    bestSectors: best ? best.sectorTimes : [], bestFuel: best ? best.fuelLevel : 0, bestTrackTemp: best ? best.trackTemp : 0, bestAirTemp: best ? best.airTemp : 0,
    lapIndex: laps.map((l) => ({ n: l.lapNumber, t: l.lapTime, s: l.sectorTimes, fuel: l.fuelLevel, tt: l.trackTemp, at: l.airTemp })) };
}
function loadSessionsDb() {
  const cached = fs.existsSync(sessionsDbFile) ? JSON.parse(fs.readFileSync(sessionsDbFile, 'utf8')) : [];
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
  const deleted = new Set(cached.filter((s) => s.deleted).map((s) => s.id));
  const db = cached.filter((s) => !s.deleted);
  for (const f of fs.readdirSync(dataFile(''))) {
    if (!f.endsWith('.delta') || f === 'reference-session.delta') continue;
    const id = f.slice(0, -6);
    const existing = db.find((s) => s.id === id);
    if (deleted.has(id)) continue;
    if (existing) { const r = crypto.createHash('sha1').update(fs.readFileSync(dataFile(f))).digest('hex').slice(0, 8); if (existing.rev === r) continue; db.splice(db.indexOf(existing), 1); }
    const bytes = fs.readFileSync(dataFile(f)); const decoded = decodeSession(bytes);
    const rev = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 8);
    const ts = meta[id]?.timestamp || (id === 'onboarding-demo' ? '2026-11-04T19:12:40.000Z' : fs.statSync(dataFile(f)).mtime.toISOString());
    db.push({ ...sessionSummary(id, decoded, ts), rev });
    console.log('sessions: indexed', f, decoded.laps.length, 'laps');
  }
  fs.writeFileSync(sessionsDbFile, JSON.stringify(db.concat(cached.filter((s) => s.deleted)), null, 1));
  return db;
}
let sessionsDb = loadSessionsDb();
// Cut the best-lap clip of every session with footage in the background, so the first click shows video immediately.
setTimeout(async () => {
  for (const s of sessionsDb) if (s.bestLapNumber && lapVideo(s.id, s.bestLapNumber)) { if (await lapClip(s.id, s.bestLapNumber)) console.log('video: best-lap clip ready for', s.id); }
  // then every other lap, one at a time, so reference laps open without a wait
  for (const s of sessionsDb) for (const l of s.lapIndex || []) if (l.n !== s.bestLapNumber && lapVideo(s.id, l.n)) await lapClip(s.id, l.n);
  console.log('video: all lap clips ready');
}, 1000);
let deletedIds = (fs.existsSync(sessionsDbFile) ? JSON.parse(fs.readFileSync(sessionsDbFile, 'utf8')) : []).filter((s) => s.deleted);
const saveSessionsDb = () => fs.writeFileSync(sessionsDbFile, JSON.stringify(sessionsDb.concat(deletedIds), null, 1));

// ---- helpers --------------------------------------------------------------------------------
const SIM_NAMES = { iracing: 'iRacing', acc: 'ACC', ac: 'Assetto Corsa', lemans_ultimate: 'Le Mans Ultimate', gran_turismo_7: 'Gran Turismo 7', ams2: 'Automobilista 2', acevo: 'Assetto Corsa EVO' };
const NAMES = fs.existsSync(dataFile('names.json')) ? readJson('names.json') : { cars: {}, tracks: {} };
const CAR_NAMES = { 'mx5 mx52016': 'Mazda MX-5', ...NAMES.cars };
const TRACK_NAMES = { 'okayama full': 'Okayama', ...NAMES.tracks };
const pretty = { car: (c) => CAR_NAMES[c] || c, track: (t) => TRACK_NAMES[t] || t, type: (t) => ({ practice: 'Practice', qualification: 'Qualifying', race: 'Race' })[t] || 'Unknown' };
const fmtLap = (ms) => { if (!ms) return '-'; const m = Math.floor(ms / 60000), s = ((ms % 60000) / 1000).toFixed(3).padStart(6, '0'); return `${m}:${s}`; };
const fmtDate = (iso) => { const d = new Date(iso); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((c) => c[0]));
const authed = (ctx) => cookies(ctx.req)[COOKIE] === 'ok';
const onboarded = (ctx) => cookies(ctx.req).delta_web_onboarded === 'ok';
const setCookie = (res, name, value, extra = '') => res.setHeader('Set-Cookie', [...(res.getHeader('Set-Cookie') || []), `${name}=${value}; Path=/; SameSite=Lax${extra}`]);

function simLogo(sim) {
  const m = raw('sessions').match(new RegExp(`data-sessions-sim-param="${sim}"[^>]*>.*?<div class="elle--imageBox">(<svg[\\s\\S]*?</svg>)</div></button>`));
  return m ? m[1] : `<span>${esc(SIM_NAMES[sim] || sim)}</span>`;
}

function sessionsRows(list, page, perPage, total) {
  const from = total ? page * perPage + 1 : 1, to = Math.min((page + 1) * perPage, total);
  const rows = list.map((s) => `<tr class="elle--tableRow history--row" data-session-id="${esc(s.id)}">
<td class="elle--tableCell -center session-delete"><button class="elle--button -danger -small" data-controller="material" data-action="click->sessions#deleteSession" data-sessions-id-param="${esc(s.id)}" type="button"><div class="elle--tooltip -center" data-controller="tooltip">Delete session</div><i class="fa elle--icon fa-trash"></i></button></td>
<td class="elle--tableCell date"><span data-controller="local-date" data-local-date-value="${esc(s.timestamp)}">${fmtDate(s.timestamp)}</span></td>
<td class="elle--tableCell -center type"><span class="elle--badge history--type -${esc(s.sessionType)}">${pretty.type(s.sessionType)}</span></td>
<td class="elle--tableCell">${esc(pretty.track(s.track))}</td>
<td class="elle--tableCell">${esc(pretty.car(s.car))}</td>
<td class="elle--tableCell -center game"><div class="elle--imageBox history--game">${simLogo(s.sim)}</div></td>
<td class="elle--tableCell -center">${s.laps}</td>
<td class="elle--tableCell -center avg monospace">${fmtLap(s.avg)}</td>
<td class="elle--tableCell -center monospace">${fmtLap(s.best)}</td>
<td class="elle--tableCell -center">${s.hasCapture ? '<button class="elle--button -small" data-controller="material" data-action="click->sessions#video" data-sessions-id-param="' + esc(s.id) + '" type="button"><i class="fa elle--icon fa-video"></i></button>' : ''}</td>
<td class="elle--tableCell -center"><span class="history--result">P${s.validLaps ? 1 : '-'}</span></td>
<td class="elle--tableCell history--small-col"><div class="elle--flex history--actions"><button class="elle--button history--open" data-controller="material" data-action="click->sessions#replay" data-sessions-id-param="${esc(s.id)}" type="button"><i class="fa elle--icon fa-play elle--buttonIcon fa-fw"></i><span>Open</span></button></div></td>
</tr>`).join('');
  const summary = `<i class="fa elle--icon fa-hashtag"></i> ${from}-${to} of ${total} `;
  return { rows, summary, prevDisabled: page <= 0, nextDisabled: (page + 1) * perPage >= total, pageNumber: page + 1 };
}

function renderSessions(ctx) {
  const sim = ctx.query.get('game') || '', page = Number(ctx.query.get('page') || 0), car = (ctx.query.get('car') || '').toLowerCase(), track = (ctx.query.get('track') || '').toLowerCase(), type = ctx.query.get('sessionType') || '';
  const perPage = 20;
  const filtered = sessionsDb.filter((s) => (!sim || s.sim === sim) && (!car || s.car.includes(car) || pretty.car(s.car).toLowerCase().includes(car)) && (!track || s.track.includes(track) || pretty.track(s.track).toLowerCase().includes(track)) && (!type || s.sessionType === type)).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const { rows, summary, prevDisabled, nextDisabled, pageNumber } = sessionsRows(filtered.slice(page * perPage, (page + 1) * perPage), page, perPage, filtered.length);
  return render('sessions', { user, replace: [
    [/<i class="fa elle--icon fa-hashtag"><\/i> 1-0 of 0 /, summary],
    ['<div class="elle--flex history--page-number">1</div>', `<div class="elle--flex history--page-number">${pageNumber}</div>`],
    [/history--page-control -disabled" data-controller="material" data-action="click-&gt;sessions#previousPage"/, `history--page-control${prevDisabled ? ' -disabled' : ''}" data-controller="material" data-action="click-&gt;sessions#previousPage"`],
    [/history--page-control -disabled" data-controller="material" data-action="click-&gt;sessions#nextPage"/, `history--page-control${nextDisabled ? ' -disabled' : ''}" data-controller="material" data-action="click-&gt;sessions#nextPage"`],
    ['</tr></thead></tbody></table>', `</tr></thead>${rows}</tbody></table>`],
    [new RegExp(`class="elle--button" (data-controller="material" data-action="click-&gt;sessions#select(All|Sim)" data-sessions-target="filterButton" data-sessions-sim-param="${sim}")`), 'class="elle--button -active" $1'],
  ] });
}

// Replay of a saved session: the driving page plus a replayer element, exactly as /onboarding/prerecorded does it.
function renderDrivingReplay(ctx, id) {
  const s = sessionsDb.find((x) => x.id === id);
  const replayer = `<div data-controller="replayer" data-replayer-id-value="${esc(s ? cacheId(s) : id)}"${s ? ` data-replayer-recorded-value="${esc(s.timestamp)}"` : ''} data-replayer-username-value="${esc(user.display_name)}" data-replayer-discordid-value="${esc(user.discord_id)}" data-replayer-avatarhash-value="${esc(user.avatar_hash)}"></div>`;
  return render('driving', { user, replace: [[/(<div class="driving--empty" data-layout-target="empty"[\s\S]*?<\/div><\/div><\/div>)(<\/div><\/div>)(<div class="dropzone")/, (m, a, b, c) => a + replayer + b + c]] });
}

function stats(period) {
  const laps = sessionsDb.reduce((n, s) => n + s.validLaps, 0), drive = sessionsDb.reduce((n, s) => n + s.driveTime, 0);
  const base = { streak_current: sessionsDb.length ? 1 : 0, streak_longest: sessionsDb.length ? 1 : 0, laps_total: laps, valid_laps_total: laps, completed_laps_total: laps, drive_time_total: drive, accuracy_total: 94, lap_time_delta_total: 1849, min_day: sessionsDb.length ? sessionsDb[sessionsDb.length - 1].timestamp : new Date().toISOString() };
  if (period === 'today') return { ...base, sessions_today: sessionsDb.length, laps_today: laps, valid_laps_today: laps, completed_laps_today: laps, drive_time_today: drive, accuracy_today: 94, lap_time_delta_today: 1849 };
  return { ...base, laps_period: laps, valid_laps_period: laps, completed_laps_period: laps, drive_time_period: drive, accuracy_period: 94, lap_time_delta_period: 1849 };
}

const CATALOG = {
  cars: [
    { sim: 'iracing', value: 'mx5 mx52016', description: 'Mazda MX-5 Cup' }, { sim: 'iracing', value: 'porsche992cup', description: 'Porsche 911 GT3 Cup (992)' }, { sim: 'iracing', value: 'ferrari296gt3', description: 'Ferrari 296 GT3' }, { sim: 'iracing', value: 'bmwm4gt3', description: 'BMW M4 GT3' },
    { sim: 'acc', value: 'porsche_992_gt3_r', description: 'Porsche 992 GT3 R' }, { sim: 'acc', value: 'ferrari_296_gt3', description: 'Ferrari 296 GT3' }, { sim: 'acc', value: 'mclaren_720s_gt3_evo', description: 'McLaren 720S GT3 Evo' },
    { sim: 'lemans_ultimate', value: 'porsche_963', description: 'Porsche 963' }, { sim: 'lemans_ultimate', value: 'ferrari_499p', description: 'Ferrari 499P' }, { sim: 'lemans_ultimate', value: 'oreca_07', description: 'Oreca 07 LMP2' },
  ],
  tracks: [
    { sim: 'iracing', value: 'okayama full', description: 'Okayama International Circuit' }, { sim: 'iracing', value: 'spa', description: 'Circuit de Spa-Francorchamps' }, { sim: 'iracing', value: 'monza full', description: 'Autodromo Nazionale Monza' }, { sim: 'iracing', value: 'silverstone 2019 gp', description: 'Silverstone Circuit' },
    { sim: 'acc', value: 'monza', description: 'Monza' }, { sim: 'acc', value: 'spa', description: 'Spa-Francorchamps' }, { sim: 'acc', value: 'nurburgring', description: 'Nürburgring' },
    { sim: 'lemans_ultimate', value: 'Autodromo Enzo e Dino Ferrari', description: 'Imola' }, { sim: 'lemans_ultimate', value: 'Circuit de la Sarthe', description: 'Le Mans' },
  ],
};
const lapFileCache = new Map();

const cacheId = (s) => `${s.id}@${s.rev || '0'}`; // Delta caches decoded sessions by id in IndexedDB; the revision busts it
const stripRev = (id) => id.replace(/@[0-9a-f]+/, '');
const ok = (data, meta = []) => ({ code: 200, messages: [], data, meta });
const notFound = { code: 404, messages: [], data: [], meta: [] };

// ---- route table ----------------------------------------------------------------------------
const route = (method, pattern, handle) => ({
  match: (ctx) => { if (method !== '*' && ctx.req.method !== method && !(method === 'GET' && ctx.req.method === 'HEAD')) return null; if (typeof pattern === 'string') return ctx.pathname === pattern ? {} : null; const m = ctx.pathname.match(pattern); return m ? (m.groups || m) : null; },
  handle,
});
const page = (ctx, body, status = 200) => ctx.html(ctx.res, body, status);
const requireAuth = (ctx) => { if (!authed(ctx)) { ctx.redirect(ctx.res, '/'); return false; } if (!onboarded(ctx) && !ctx.pathname.startsWith('/onboarding')) { ctx.redirect(ctx.res, '/onboarding/prerecorded'); return false; } return true; };

export const routes = [
  // ---- auth ----
  route('GET', '/', (ctx) => authed(ctx) ? ctx.redirect(ctx.res, onboarded(ctx) ? '/dashboard' : '/onboarding/prerecorded') : page(ctx, render('splash', { user: null, config: { oauth_endpoint: '' } }))),
  route('GET', '/api/connect/discord', (ctx) => { setCookie(ctx.res, COOKIE, 'ok', '; Max-Age=2592000'); ctx.redirect(ctx.res, '/'); }),
  route('GET', '/connect/discord/authenticated', (ctx) => ctx.redirect(ctx.res, '/')),
  route('GET', '/auth/logout', (ctx) => { setCookie(ctx.res, COOKIE, '', '; Max-Age=0'); ctx.redirect(ctx.res, '/'); }),
  route('GET', '/auth/keepalive', (ctx) => ctx.json(ctx.res, ok([]))),
  route('GET', '/auth/timeout', (ctx) => ctx.redirect(ctx.res, '/')),

  // ---- onboarding ----
  route('GET', '/onboarding/prerecorded', (ctx) => authed(ctx) && page(ctx, render('onboarding-prerecorded', { user, data: { onboarding: true } }))),
  route('GET', '/onboarding/session', (ctx) => authed(ctx) && page(ctx, render('onboarding-session', { user, data: { onboarding: true } }))),
  route('GET', '/onboarding/session.delta', (ctx) => ctx.sendStatic(ctx.res, dataFile('onboarding-demo.delta'))),
  route('GET', /^\/onboarding(\/.*)?$/, (ctx) => { setCookie(ctx.res, 'delta_web_onboarded', 'ok', '; Max-Age=31536000'); ctx.redirect(ctx.res, '/dashboard'); }),
  route('POST', /^\/api\/onboarding(\/.*)?$/, (ctx) => { setCookie(ctx.res, 'delta_web_onboarded', 'ok', '; Max-Age=31536000'); ctx.json(ctx.res, ok([])); }),

  // ---- main views ----
  route('GET', '/dashboard', (ctx) => requireAuth(ctx) && page(ctx, render('home', { user }))),
  route('GET', '/sessions', (ctx) => requireAuth(ctx) && page(ctx, renderSessions(ctx))),
  route('GET', '/driving', (ctx) => requireAuth(ctx) && page(ctx, render('driving', { user }))),
  route('GET', /^\/driving\/(?<id>[^/]+)$/, (ctx, m) => requireAuth(ctx) && page(ctx, renderDrivingReplay(ctx, m.id))),
  route('GET', /^\/driving\/(?<id>[^/]+)\/video$/, (ctx, m) => ctx.redirect(ctx.res, '/driving/' + m.id + '?capture=1')),
  route('GET', '/leaderboards', (ctx) => requireAuth(ctx) && page(ctx, render('leaderboards', { user }))),
  route('GET', '/profile', (ctx) => requireAuth(ctx) && page(ctx, render('profile', { user }))),
  route('GET', '/app-required', (ctx) => page(ctx, render('app-required', { user: null }))),

  // ---- files ----
  // <session>-lap-<n>.delta: a single lap cut out of a saved session, used as a reference lap.
  route('GET', /^\/files\/(?<id>[A-Za-z0-9._-]+)-lap-(?<n>\d+)\.delta$/, (ctx, m) => {
    const src = dataFile(m.id + '.delta'); if (!fs.existsSync(src)) return ctx.json(ctx.res, notFound, 404);
    const key = `${m.id}-lap-${m.n}`; let buf = lapFileCache.get(key);
    if (!buf) { const d = decodeSession(fs.readFileSync(src)); const lap = d.laps.find((l) => l.lapNumber === Number(m.n)); if (!lap) return ctx.json(ctx.res, notFound, 404); buf = encodeSession({ session: d.session, laps: [lap] }); lapFileCache.set(key, buf); }
    ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store' }); ctx.res.end(buf);
  }),
  route('GET', /^\/files\/(?<name>[A-Za-z0-9._-]+\.delta)$/, (ctx, m) => { const f = dataFile(m.name); if (!ctx.sendStatic(ctx.res, f)) ctx.json(ctx.res, notFound, 404); }),

  // ---- API: stats / profile ----
  route('GET', '/api/stats', (ctx) => ctx.json(ctx.res, ok(stats('today')))),
  route('GET', /^\/api\/stats\/(?<period>week|month|year)$/, (ctx, m) => ctx.json(ctx.res, ok(stats(m.period)))),
  route('POST', /^\/api\/profile\/.*$/, (ctx) => ctx.json(ctx.res, ok([]))),
  route('GET', '/api/teams', (ctx) => ctx.json(ctx.res, readJson('teams.json'))),
  route('GET', '/api/teams/summary', (ctx) => ctx.json(ctx.res, ok({ teammates: 0, fastestLapMs: null }))),

  // ---- API: sessions ----
  route('GET', /^\/api\/sessions\/(?<id>[^/]+)\/file$/, (ctx, m) => {
    const lapRef = stripRev(m.id).match(/^(?<sid>.+)-lap-(?<n>\d+)$/);
    if (lapRef) { const s = sessionsDb.find((x) => x.id === lapRef.groups.sid); if (s) return ctx.json(ctx.res, ok({ url: `/files/${s.id}-lap-${lapRef.groups.n}.delta`, timestamp: s.timestamp, car: s.car, track: s.track, sim: s.sim, type: s.sessionType })); }
    const s = sessionsDb.find((x) => x.id === stripRev(m.id));
    if (s) return ctx.json(ctx.res, ok({ url: '/files/' + s.file, timestamp: s.timestamp, car: s.car, track: s.track, sim: s.sim, type: s.sessionType }));
    // Leaderboard reference laps all resolve to the bundled reference session (same car/track).
    if (ctx.query.get('discordId') || /^[0-9a-f-]{36}$/.test(m.id)) return ctx.json(ctx.res, ok({ url: '/files/reference-session.delta', timestamp: '2026-09-22T15:33:50.438Z', car: 'mx5 mx52016', track: 'okayama full', sim: 'iracing', type: 'practice' }));
    ctx.json(ctx.res, notFound, 404);
  }),
  route('DELETE', /^\/api\/session\/(?<id>[^/]+)$/, (ctx, m) => { const id = stripRev(m.id); if (sessionsDb.some((s) => s.id === id)) deletedIds.push({ id, deleted: true }); sessionsDb = sessionsDb.filter((s) => s.id !== id); saveSessionsDb(); ctx.json(ctx.res, ok([])); }),
  route('GET', /^\/api\/session\/(?<id>[^/]+)\/capture$/, async (ctx, m) => {
    const bare = stripRev(m.id); const lapRef = bare.match(/^(?<sid>.+)-lap-(?<n>\d+)$/);
    const sid = lapRef ? lapRef.groups.sid : bare; const s = sessionsDb.find((x) => x.id === sid);
    const n = lapRef ? Number(lapRef.groups.n) : (s ? bestLapNumber(s) : 0);
    if (!s || !n || !lapVideo(sid, n)) return ctx.json(ctx.res, { code: 400, messages: [], data: [], meta: [] }, 400);
    const clip = await lapClip(sid, n);
    if (!clip) return ctx.json(ctx.res, { code: 400, messages: [], data: [], meta: [] }, 400);
    ctx.json(ctx.res, ok({ url: `/videos/${sid}-lap-${n}.mp4`, sessionId: m.id, lapNumber: n, hasAudio: true }));
  }),
  route('GET', /^\/videos\/(?<id>[A-Za-z0-9._-]+)-lap-(?<n>\d+)\.mp4$/, async (ctx, m) => {
    const clip = await lapClip(m.id, Number(m.n));
    if (!clip || !ctx.sendStatic(ctx.res, clip, {}, ctx.req)) ctx.json(ctx.res, notFound, 404);
  }),
  route('*', /^\/api\/session\/.*$/, (ctx) => ctx.json(ctx.res, ok([]))),
  route('GET', /^\/api\/videos\/.*$/, (ctx) => ctx.json(ctx.res, ctx.pathname.includes('okayama') ? readJson('videos-okayama.json') : ok([]))),

  // ---- API: driving data ----
  route('GET', /^\/api\/driving\/track-maps\/(?<sim>[^/]+)\/(?<track>.+)$/, (ctx, m) => {
    const f = dataFile(`trackmap-${m.sim}-${m.track.replace(/[^a-z0-9]+/gi, '-')}.json`);
    if (fs.existsSync(f)) return ctx.json(ctx.res, readJson(path.basename(f)));
    if (m.sim === 'lemans_ultimate') return ctx.json(ctx.res, readJson('trackmap-lmu-imola.json'));
    ctx.json(ctx.res, ok([]));
  }),
  route('GET', '/api/driving/iracing/catalog', (ctx) => ctx.json(ctx.res, readJson('iracing-catalog.json'))),
  route('GET', /^\/api\/(?<sim>[a-z0-9_]+)\/cars\/(?<car>[^/]+)\/description$/, (ctx, m) => ctx.json(ctx.res, m.car === 'mx5 mx52016' ? readJson('car-mx5.json') : ok({ description: pretty.car(m.car) }))),
  route('GET', /^\/api\/(?<sim>[a-z0-9_]+)\/tracks\/(?<track>[^/]+)\/description$/, (ctx, m) => ctx.json(ctx.res, ok({ description: pretty.track(m.track) }))),
  route('POST', /^\/api\/driving\/(share|status\/start|status\/end)$/, (ctx) => ctx.json(ctx.res, ok({ url: 'http://localhost/shared/local' }))),
  route('GET', /^\/api\/leaderboard\/(?<sim>[^/]+)\/(?<car>[^/]+)\/(?<track>[^/]+)\/pros$/, (ctx, m) => ctx.json(ctx.res, m.track === 'okayama full' ? readJson('leaderboard-pros.json') : ok([]))),
  route('GET', /^\/api\/leaderboard\/(?<sim>[^/]+)\/(?<car>[^/]+)\/(?<track>[^/]+)$/, (ctx, m) => {
    if (m.sim === 'iracing' && m.track === 'okayama full') {
      const lb = readJson('leaderboard.json');
      if (ctx.query.get('proOnly') === 'true') lb.data.leaderboard = lb.data.leaderboard.filter((r) => r.cda);
      if (ctx.query.get('fixedOnly') === 'true') lb.data.leaderboard = lb.data.leaderboard.filter((r) => r.is_fixed);
      return ctx.json(ctx.res, lb);
    }
    // Local sessions form their own board: one entry per session's best lap, so the Delta graph has a reference.
    const local = sessionsDb.filter((s) => s.sim === m.sim && s.car === m.car && s.track === m.track && s.best > 0).sort((a, b) => a.best - b.best);
    if (local.length) {
      // Every valid lap you drove is an entry, so there is always a lap "just ahead" to use as the reference.
      const leaderboard = local.flatMap((s) => (s.lapIndex || [{ n: s.bestLapNumber, t: s.best, s: s.bestSectors, fuel: s.bestFuel, tt: s.bestTrackTemp, at: s.bestAirTemp }]).map((l) => ({
        user_id: user.discord_id, lap_id: `${s.id}-lap-${l.n}`, lap_number: l.n, lap_time: l.t, session_id: `${cacheId(s)}-lap-${l.n}`, sector_times: l.s || [],
        lap_created_at: s.timestamp, car: s.car, is_fixed: false, rain_intensity: 0, fuel_level: l.fuel || 0, track_temp: l.tt || 0, air_temp: l.at || 0, has_capture: !!lapVideo(s.id, l.n),
        username: user.display_name, avatarHash: user.avatar_hash, laptime: fmtLap(l.t), cda: false }))).sort((a, b) => a.lap_time - b.lap_time);
      if (ctx.query.get('fastestOnly') === 'true') leaderboard.splice(1);
      return ctx.json(ctx.res, ok({ leaderboard, lapPercentiles: {}, sectorPercentiles: {}, count: String(leaderboard.length), capturesLeaderboard: [], filteredBest: null, lastUpdated: Date.now() / 1000 | 0, boardUnavailable: false, conditionOptions: {}, teamBoard: false, boardQuery: '', conditions: null, conditionsFallback: false, conditionsUnsupported: null, rejected: false }));
    }
    ctx.json(ctx.res, ok({ leaderboard: [], lapPercentiles: {}, sectorPercentiles: {}, count: '0', capturesLeaderboard: [], filteredBest: null, lastUpdated: Date.now() / 1000 | 0, boardUnavailable: false, conditionOptions: {}, teamBoard: false, boardQuery: '', conditions: null, conditionsFallback: false, conditionsUnsupported: null, rejected: false }));
  }),
  route('GET', /^\/api\/(?<kind>cars|tracks)\/search$/, (ctx, m) => {
    const q = (ctx.query.get(m.kind === 'cars' ? 'carSearch' : 'trackSearch') || ctx.query.get(m.kind === 'cars' ? 'car' : 'track') || ctx.query.get('q') || '').toLowerCase();
    const sim = ctx.query.get('sim') || ctx.query.get('game') || '';
    const all = m.kind === 'cars' ? CATALOG.cars : CATALOG.tracks;
    const results = all.filter((r) => (!sim || r.sim === sim) && (!q || r.value.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))).map(({ value, description }) => ({ value, description }));
    ctx.json(ctx.res, ok({ results }));
  }),
  route('GET', /^\/api\/upload.*$/, (ctx) => ctx.json(ctx.res, ok([]))),
  route('*', /^\/api\/.*$/, (ctx) => ctx.json(ctx.res, ok([]))),
];
