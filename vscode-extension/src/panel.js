'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const {
  SessionMonitor,
  discoverSessions,
  siblingSessions,
  sessionTitle,
} = require('../dist/monitor.cjs'); // built by scripts/build.mjs

// current = { panel, monitor, target } — single town tab.
// target: the SessionInfo to monitor (null = hottest). Switching sets target and
// reloads the webview, which replays the entrance animation against the new village.
let current;

function nonce() {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function renderHtml(webview, extensionPath) {
  const mediaDir = path.join(extensionPath, 'media');
  const uri = (f) => webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir, f))).toString();
  const html = fs.readFileSync(path.join(mediaDir, 'index.html'), 'utf8');
  return html
    .replace(/\$\{cspSource\}/g, webview.cspSource)
    .replace(/\$\{nonce\}/g, nonce())
    .replace(/\$\{shimUri\}/g, uri('shim.js'))
    .replace(/\$\{rendererUri\}/g, uri('renderer.js'));
}

// Weather via the extension host (no CORS), keyless Open-Meteo.
async function getWeather(city) {
  try {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`,
    ).then((r) => r.json());
    if (!geo.results || !geo.results.length) return { error: 'not_found' };
    const g = geo.results[0];
    const wx = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current=weather_code,temperature_2m`,
    ).then((r) => r.json());
    const code = (wx.current && wx.current.weather_code) || 0;
    const temp = Math.round((wx.current && wx.current.temperature_2m) || 0);
    return { name: g.name, code, temp };
  } catch (e) {
    return { error: 'fetch_failed' };
  }
}

// Keep only the most-recently-active villages (Claude's set of OPEN tabs isn't exposed
// to extensions, so "recently active" is the closest proxy). Always include the current
// session so you can navigate away from an older chat you've opened.
function recentVillages(sibs, currentId, max) {
  if (sibs.length <= max) return sibs;
  const top = sibs.slice(0, max); // sibs are hottest-first
  if (top.some((s) => s.sessionId === currentId)) return top;
  const cur = sibs.find((s) => s.sessionId === currentId);
  return cur ? [...sibs.slice(0, max - 1), cur] : top;
}

// Left/right navigation to sibling conversations of the SAME project (villages).
// prev/next with wrap; with exactly 2 sessions both directions are the same other
// village, so we only surface one sign (right).
async function computeNeighbors(monitor) {
  const cur = monitor.currentSession;
  if (!cur) return { left: null, right: null };
  let sibs = [];
  try { sibs = await siblingSessions(cur.projectDir); } catch (_) { return { left: null, right: null }; }
  // cap to the N most recent so a project with dozens of old chats doesn't cycle them all
  // (N comes from the webview settings popup, via setMaxVillages)
  const max = Math.max(2, (current && current.maxVillages) || 6);
  sibs = recentVillages(sibs, cur.sessionId, max);
  if (sibs.length < 2) return { left: null, right: null };
  const idx = sibs.findIndex((s) => s.sessionId === cur.sessionId);
  if (idx < 0) return { left: null, right: null };
  const n = sibs.length;
  const leftS = sibs[(idx - 1 + n) % n];
  const rightS = sibs[(idx + 1) % n];
  const out = { left: null, right: null };
  out.right = { sessionId: rightS.sessionId, title: await sessionTitle(rightS.mainFile) };
  if (leftS.sessionId !== rightS.sessionId) {
    out.left = { sessionId: leftS.sessionId, title: await sessionTitle(leftS.mainFile) };
  }
  return out;
}

// (Re)start the monitor for current.target (or hottest) and tell the webview about
// the session + its sibling villages. Fired on every webview 'ready' (incl. reloads).
async function activateTarget() {
  if (!current) return;
  if (current.monitor) { try { current.monitor.stop(); } catch (_) {} current.monitor = null; }
  const panel = current.panel;
  const monitor = new SessionMonitor((changes) => {
    if (current && current.panel === panel) panel.webview.postMessage({ type: 'agent-diff', changes });
  });
  current.monitor = monitor;

  let session;
  try {
    session = await monitor.start(current.target || undefined);
  } catch (e) {
    console.error('[Agentville] monitor.start failed:', e);
  }
  // panel closed or another switch superseded us while start() was awaiting — don't
  // leak this monitor's watchers/timer, and don't post into a stale/closed webview.
  if (!current || current.monitor !== monitor) {
    try { monitor.stop(); } catch (_) {}
    return;
  }
  let title = '';
  if (session) { try { title = await sessionTitle(session.mainFile); } catch (_) {} }
  panel.webview.postMessage({
    type: 'session-info',
    info: session ? { projectName: monitor.projectName || 'project', sessionId: session.sessionId, title } : null,
  });
  try {
    panel.webview.postMessage({ type: 'neighbors', neighbors: await computeNeighbors(monitor) });
  } catch (e) {
    console.error('[Agentville] neighbors failed:', e);
  }
  // If the panel was opened in a background column (not the active tab), onDidChangeViewState
  // won't have fired yet — sync the initial visibility so we don't run the monitor + render
  // loop full-tilt behind another tab, competing with Claude for the shared host.
  if (!panel.visible) {
    try { monitor.pause(); } catch (_) {}
    try { panel.webview.postMessage({ type: 'visibility', visible: false }); } catch (_) {}
  }
}

// Switch to another village: pin the chosen session and reload the webview. The
// fresh load re-runs the renderer (clean Pixi + entrance reveal) and fires 'ready',
// where activateTarget() picks up the new target.
async function doSwitch(context, sessionId) {
  if (!current || !sessionId) return false;
  let target;
  try { target = (await discoverSessions()).find((s) => s.sessionId === sessionId); } catch (_) {}
  if (!target) return false;
  current.target = target;
  current.panel.webview.html = renderHtml(current.panel.webview, context.extensionPath);
  return true;
}

/** Open (or reveal) the Agentville town panel. */
function openPanel(context) {
  if (current) {
    current.panel.reveal(current.panel.viewColumn || vscode.ViewColumn.Active);
    return;
  }

  const panel = vscode.window.createWebviewPanel('agentville', 'Agentville 🏘️', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
  });
  current = { panel, monitor: null, target: null, maxVillages: 6 };
  panel.webview.html = renderHtml(panel.webview, context.extensionPath);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg) return;
    if (msg.type === 'weberror') { console.error('[Agentville webview]', msg.message); return; }
    if (msg.type === 'ready') { await activateTarget(); return; }
    if (msg.type === 'request') {
      if (msg.method === 'switchSession') {
        const ok = await doSwitch(context, (msg.args || [])[0]);
        panel.webview.postMessage({ type: 'response', id: msg.id, result: ok });
        return;
      }
      if (msg.method === 'setMaxVillages') {
        if (current) current.maxVillages = Math.max(2, Number((msg.args || [])[0]) || 6);
        try {
          if (current && current.monitor) {
            panel.webview.postMessage({ type: 'neighbors', neighbors: await computeNeighbors(current.monitor) });
          }
        } catch (e) { console.error('[Agentville] recompute neighbors failed:', e); }
        panel.webview.postMessage({ type: 'response', id: msg.id, result: true });
        return;
      }
      // Defaults must be SAFE shapes — the renderer iterates the snapshot and reads
      // .error on the weather result at module-eval; undefined → blank panel.
      let result = msg.method === 'getSnapshot' ? [] : { error: 'fetch_failed' };
      try {
        if (msg.method === 'getSnapshot') result = (current && current.monitor ? current.monitor.getSnapshot() : []) || [];
        else if (msg.method === 'getWeather') result = await getWeather((msg.args || [])[0]);
      } catch (e) {
        console.error('[Agentville] request failed:', msg.method, e);
      }
      panel.webview.postMessage({ type: 'response', id: msg.id, result });
    }
  }, undefined, context.subscriptions);

  // Pause the village while it's hidden behind another tab. The panel + Claude Code
  // share one extension-host and one webview-renderer process; left running, the
  // monitor's file polling and Pixi's render loop compete with Claude for those
  // resources and can stall the conversation. Suspend both when not visible.
  panel.onDidChangeViewState((e) => {
    if (!current || current.panel !== panel) return;
    const visible = e.webviewPanel.visible;
    if (visible) {
      if (current.monitor) void current.monitor.resume();
    } else if (current.monitor) {
      current.monitor.pause();
    }
    try { panel.webview.postMessage({ type: 'visibility', visible }); } catch (_) {}
  }, undefined, context.subscriptions);

  panel.onDidDispose(() => {
    if (current && current.monitor) { try { current.monitor.stop(); } catch (_) {} }
    current = undefined;
  }, undefined, context.subscriptions);
}

module.exports = { openPanel };
