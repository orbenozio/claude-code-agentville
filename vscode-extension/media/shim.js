// Webview bridge shim — provides window.agentville over VSCode's postMessage so the
// Pixi renderer (renderer.js) runs UNCHANGED inside a VSCode webview panel. Loaded as
// a classic script BEFORE the renderer module, so window.agentville exists when the
// module evaluates. Mirrors the old Electron preload's contextBridge surface.
(function () {
  'use strict';

  // ── Visible error overlay ─────────────────────────────────────────────────
  // A webview has no visible console; a thrown error during module eval just
  // leaves a blank panel. Surface any error as a red overlay + a host log line.
  var vscode;
  function showErr(msg) {
    try {
      var o = document.getElementById('agentville-err');
      if (!o) {
        o = document.createElement('div');
        o.id = 'agentville-err';
        o.style.cssText =
          'position:fixed;left:0;top:0;right:0;z-index:99999;max-height:70vh;overflow:auto;' +
          'background:rgba(150,0,0,.94);color:#fff;font:12px/1.45 monospace;white-space:pre-wrap;' +
          'padding:10px 12px;box-shadow:0 2px 8px rgba(0,0,0,.4);';
        (document.body || document.documentElement).appendChild(o);
      }
      o.textContent = 'Agentville webview error:\n' + msg;
    } catch (e) { /* ignore */ }
    try { if (vscode) vscode.postMessage({ type: 'weberror', message: String(msg) }); } catch (e) {}
  }
  window.addEventListener('error', function (e) {
    showErr((e.error && (e.error.stack || e.error.message)) || e.message || String(e));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    showErr('unhandledrejection: ' + ((r && (r.stack || r.message)) || String(r)));
  });

  vscode = acquireVsCodeApi(); // may only be called once per webview — we own it
  var diffCbs = [];
  var sessCbs = [];
  var nbCbs = [];
  var pending = new Map();
  var reqId = 0;

  window.addEventListener('message', function (e) {
    var m = (e && e.data) || {};
    if (m.type === 'agent-diff') {
      for (var i = 0; i < diffCbs.length; i++) diffCbs[i](m.changes);
    } else if (m.type === 'session-info') {
      for (var j = 0; j < sessCbs.length; j++) sessCbs[j](m.info);
    } else if (m.type === 'neighbors') {
      for (var k = 0; k < nbCbs.length; k++) nbCbs[k](m.neighbors);
    } else if (m.type === 'response') {
      var r = pending.get(m.id);
      if (r) { pending.delete(m.id); r(m.result); }
    }
  });

  function request(method, args) {
    return new Promise(function (resolve) {
      var id = ++reqId;
      pending.set(id, resolve);
      vscode.postMessage({ type: 'request', id: id, method: method, args: args || [] });
    });
  }

  window.agentville = {
    onAgentDiff: function (cb) { diffCbs.push(cb); },
    onSessionInfo: function (cb) { sessCbs.push(cb); },
    onNeighbors: function (cb) { nbCbs.push(cb); },
    getSnapshot: function () { return request('getSnapshot'); },
    getWeather: function (city) { return request('getWeather', [city]); },
    switchSession: function (sessionId) { return request('switchSession', [sessionId]); },
  };

  // Tell the host the webview is alive and listening — it starts the monitor now,
  // so no early agent-diff is emitted before our callbacks are registered.
  vscode.postMessage({ type: 'ready' });
})();
