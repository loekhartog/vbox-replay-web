// Turns captured server-rendered pages into templates for the local server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SIGNATURE = '6.4.0.1793636640';
const i18n = JSON.parse(fs.readFileSync(path.join(root, 'data', 'ellei18n.json'), 'utf8'));
const elledata = JSON.parse(fs.readFileSync(path.join(root, 'data', 'elledata.json'), 'utf8'));

export function baseConfig(user, extra = {}) {
  return {
    jwt: 'web.local.session', version: '6.4.1', signature: SIGNATURE, log_filter: ['debug'],
    oauth_endpoint: '', cda_endpoint: '', // the bundle reads these keys; left empty, sign-in is local
    cda_client: 'local', cda_redirect: '/connect/cda/redirect', authenticated: !!user,
    coaching_entitled: false, timeout_after_mins: 1440, timeout_interval_mins: 10, auto_opt_in_gt7: false,
    notifications: [], display_name: user?.display_name || '', avatar_hash: user?.avatar_hash || '',
    discord_id: user?.discord_id || '', cda_pro: false, simgrid_id: '', dg_edge_redirect: '/connect/dg-edge/redirect',
    products: { 74099: { code: 'iracing', description: 'iRacing' }, 82685: { code: 'acc', description: 'ACC' } },
    capture_killswitch: false, teams_killswitch: false, ...extra,
  };
}

const cache = new Map();
export function raw(name) {
  if (!cache.has(name)) cache.set(name, fs.readFileSync(path.join(root, 'views', 'raw', name + '.html'), 'utf8'));
  return cache.get(name);
}

// Captured pages carry the capturing account, analytics tags and CSRF tokens. Normalise them.
export function render(name, { user, config = {}, data = {}, replace = [] } = {}) {
  let html = raw(name);
  html = html.replace(/<script[^>]*googletagmanager[^>]*><\/script>/g, '')
    .replace(/<script>\s*window\.dataLayer[\s\S]*?<\/script>/, '')
    .replace(/<script>\s*\(function\(h,o,t,j,a,r\)[\s\S]*?<\/script>/, '')
    .replace(/<script[^>]*hotjar[^>]*><\/script>/g, '');
  html = html.replace(/<script id="elleconfig" type="application\/json">[\s\S]*?<\/script>/,
    () => `<script id="elleconfig" type="application/json">${JSON.stringify(baseConfig(user, config))}</script>`);
  html = html.replace(/<script id="elledata" type="application\/json">[\s\S]*?<\/script>/,
    () => `<script id="elledata" type="application/json">${JSON.stringify({ ...elledata, ...data })}</script>`);
  html = html.replace(/<script id="ellei18n" type="application\/json">[\s\S]*?<\/script>/,
    () => `<script id="ellei18n" type="application/json">${JSON.stringify(i18n)}</script>`);
  html = html.replace(/<meta name="elle-csrf-token" content="[^"]*">/, '<meta name="elle-csrf-token" content="local-csrf">');
  // Account that performed the capture -> current user
  html = html.replace(/https:\/\/cdn\.discordapp\.com\/avatars\/410170562661318658\/409579d78df574682e0dbb328fc69297\.png\?size=128/g, user?.avatar || '/images/avatar-default.png')
    .replace(/410170562661318658/g, user?.discord_id || '').replace(/>loekhartog</g, `>${user?.display_name || ''}<`);
  html = html.replace(/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">/, '<link href="/fonts/fonts.css" rel="stylesheet"><link href="/web-overrides.css" rel="stylesheet">')
    .replace(/<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com">/, '');
  // Browser bridge must exist before delta.js evaluates
  html = html.replace(/<script src="\/dist\/[^"]+\/delta\.js"><\/script>/, `<script src="/web-shim.js"></script><script src="/dist/${SIGNATURE}/delta.js"></script>`);
  for (const [from, to] of replace) html = html.replace(from, to);
  return html;
}
