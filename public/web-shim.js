/* Browser replacement for the Electron preload bridge (window.ipcRenderer) and the
 * desktop-side handlers of the original Electron main process. Settings live in localStorage. */
(function () {
  'use strict';
  var SETTINGS_KEY = 'delta.web.settings';
  var defaults = { openAtLogin: false, minimizeToTray: false, startMinimized: false, keepSetups: false,
    captures: true, captureStints: 5, gt7bindPort: 33740, ps5Ip: '' };
  function load() { try { return Object.assign({}, defaults, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { return Object.assign({}, defaults); } }
  function save(patch) { var s = Object.assign(load(), patch); localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); return s; }

  var listeners = {};
  function on(ch, cb) { (listeners[ch] = listeners[ch] || []).push(cb); }
  function off(ch, cb) { if (!listeners[ch]) return; listeners[ch] = cb ? listeners[ch].filter(function (f) { return f !== cb; }) : []; }
  function emit(ch) { var args = Array.prototype.slice.call(arguments, 1); (listeners[ch] || []).slice().forEach(function (cb) { try { cb.apply(null, [{ sender: ipc }].concat(args)); } catch (e) { console.error('[web-shim]', ch, e); } }); }
  function later(fn) { setTimeout(fn, 0); }

  var handlers = {
    'openExternal': function (url) { window.open(url, '_blank', 'noopener'); },
    'requestMinimize': function () { document.body.classList.toggle('web--minimized'); },
    'requestMaximize': function () { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(function () {}); },
    'requestQuit': function () { if (confirm('Quit?')) window.location.href = '/auth/logout'; },
    'set-zoom-factor': function (f) { document.documentElement.style.zoom = f; },
    'set-jwt': function () {}, 'set-discord-id': function () {},
    'get-login-setting': function () { later(function () { emit('receive-login-setting', load().openAtLogin); }); },
    'set-login-setting': function (v) { save({ openAtLogin: !!v }); },
    'get-tray-settings': function () { later(function () { var s = load(); emit('receive-tray-settings', { minimizeToTray: s.minimizeToTray, startMinimized: s.startMinimized }); }); },
    'set-tray-settings': function (v) { save({ minimizeToTray: !!(v && v.minimizeToTray), startMinimized: !!(v && v.startMinimized) }); },
    'get-keep-setups': function () { later(function () { emit('receive-keep-setups', load().keepSetups); }); },
    'set-keep-setups': function (v) { save({ keepSetups: v === true }); },
    'get-captures-config': function () { later(function () { emit('receive-captures-config', load().captures); }); },
    'set-captures-config': function (v) { save({ captures: Array.isArray(v) ? (v.length ? v : false) : v !== false }); },
    'set-captures-disabled': function () {},
    'get-capture-stints': function () { later(function () { emit('receive-capture-stints', load().captureStints); }); },
    'set-capture-stints': function (v) { save({ captureStints: Math.min(Math.max(parseInt(v, 10) || 5, 1), 20) }); },
    'get-gt7-config': function () { later(function () { var s = load(); emit('receive-gt7-config', { port: s.gt7bindPort, ip: s.ps5Ip }); }); },
    'set-gt7-config': function (v) { save({ gt7bindPort: (v && v.port) || defaults.gt7bindPort, ps5Ip: (v && v.ip) || '' }); },
    'enable-gt7': function () { save({ gt7Enabled: true }); }, 'disable-gt7': function () { save({ gt7Enabled: false }); },
    'gt7-ping': function () { later(function () { emit('gt7-pong', false); }); },
    'reset-config': function () { localStorage.removeItem(SETTINGS_KEY); var s = load();
      later(function () { emit('receive-login-setting', s.openAtLogin); emit('receive-tray-settings', { minimizeToTray: s.minimizeToTray, startMinimized: s.startMinimized }); emit('receive-keep-setups', s.keepSetups); emit('receive-captures-config', s.captures); emit('receive-capture-stints', s.captureStints); emit('receive-gt7-config', { port: s.gt7bindPort, ip: s.ps5Ip }); }); },
    'request-save-session': function () {}, 'share-session': function () { later(function () { emit('share-session-result', null); }); },
    'write': function () {}, 'purge': function () {},
    'SPAWN_OVERLAY': function (o) { if (o && o.url) window.open(o.url, 'delta-overlay', 'popup,width=' + (o.width || 420) + ',height=' + (o.height || 260)); },
    'DETECTION_EVENT_RESULT': function () {}, 'DEBUG_LOG': function () {}, 'ENABLE_REPLAY_CAPTURE': function () {}
  };
  var invokeHandlers = {
    'check-setups': function () { return Promise.resolve([]); },
    'garage-summary': function () { return Promise.resolve(null); },
    'read-setup': function () { return Promise.resolve(null); },
    'retry-reload': function () { window.location.reload(); return Promise.resolve(); }
  };

  var ipc = {
    send: function (ch) { var args = Array.prototype.slice.call(arguments, 1); if (handlers[ch]) handlers[ch].apply(null, args); else console.debug('[web-shim] unhandled send', ch, args); },
    invoke: function (ch) { var args = Array.prototype.slice.call(arguments, 1); return invokeHandlers[ch] ? invokeHandlers[ch].apply(null, args) : Promise.resolve(null); },
    on: on, once: function (ch, cb) { var w = function () { off(ch, w); cb.apply(null, arguments); }; on(ch, w); },
    off: off, removeListener: off, removeAllListeners: function (ch) { off(ch); },
    emit: emit
  };
  window.isElectron = true;
  window.isMacOS = false;
  window.ipcRenderer = ipc;
  window.__deltaWeb = { settings: load, save: save };
})();
