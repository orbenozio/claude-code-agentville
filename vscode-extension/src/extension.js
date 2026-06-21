'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const { BACKUP_SUFFIX, FOREIGN_MARKER } = require('./constants');
const injector = require('./injector');
const { writeAndVerify } = require('./atomicWrite');
const { resolveTargets } = require('./targets/claude-code');
const statusBar = require('./statusBar');
const updater = require('./updater');
const { openPanel, togglePanel } = require('./panel');

let reinjectTimer = null;
let lastFocusCheck = 0;
const FOCUS_REINJECT_THROTTLE_MS = 30000;

function getConfig() {
  return vscode.workspace.getConfiguration('agentville');
}

function loadWebviewScript(context) {
  const p = path.join(context.extensionPath, 'webview', 'agentville.js');
  return fs.readFileSync(p, 'utf8');
}

function backupPathFor(indexPath) {
  return indexPath + BACKUP_SUFFIX;
}

/** Emergency-only backup (never used for blind restore — removal strips our markers). */
function ensureBackup(indexPath) {
  const bp = backupPathFor(indexPath);
  if (!fs.existsSync(bp)) {
    try { fs.copyFileSync(indexPath, bp); } catch (_) { /* best effort */ }
  }
}

/** Inject (or refresh) Agentville into a single target. Returns true if changed. */
function injectTarget(target, version, scriptBody) {
  let content;
  try {
    content = fs.readFileSync(target.indexPath, 'utf8');
  } catch (_) {
    return false;
  }
  const next = injector.inject(content, version, scriptBody);
  if (next === content) return false; // already current (version + code match)

  ensureBackup(target.indexPath);
  const ok = writeAndVerify(
    target.indexPath,
    next,
    (written) => injector.hasValidInjection(written, version),
    { retries: 3, backoffMs: 50 }
  );
  if (!ok) console.error(`[Agentville] write race not resolved for ${target.indexPath}`);
  if (next.includes(FOREIGN_MARKER)) {
    console.log('[Agentville] coexisting with Nonstop in', target.name);
  }
  return ok;
}

function checkAndInject(context, { interactive = false } = {}) {
  const c = getConfig();
  if (!c.get('autoInject', true) && !interactive) return { changed: 0, targets: 0 };

  const version = context.extension.packageJSON.version;
  const scriptBody = loadWebviewScript(context);
  const targets = resolveTargets(vscode);

  let changed = 0;
  for (const t of targets) {
    if (injectTarget(t, version, scriptBody)) changed++;
  }
  const result = { changed, targets: targets.length };
  statusBar.reflect(result);
  return result;
}

/** Remove ONLY our blocks from every target. Never blind-restore the backup —
 *  that could resurrect a stale Claude file or another extension's old block. */
function removeInjection() {
  const targets = resolveTargets(vscode);
  let changed = 0;
  for (const t of targets) {
    let content;
    try { content = fs.readFileSync(t.indexPath, 'utf8'); } catch (_) { continue; }
    const blocks = injector.findBlocks(content);
    if (blocks.length === 0) continue;
    const cleaned = injector.stripAllBlocks(content).replace(/\s+$/, '') + '\n';
    writeAndVerify(t.indexPath, cleaned, (w) => injector.findBlocks(w).length === 0);
    try { fs.unlinkSync(backupPathFor(t.indexPath)); } catch (_) { /* ignore */ }
    changed++;
  }
  return changed;
}

let reinjectDisposed = false;
function scheduleReinject(context) {
  if (reinjectTimer) { clearInterval(reinjectTimer); reinjectTimer = null; }
  const hours = Number(getConfig().get('reinjectCheckHours', 6)) || 0;
  if (hours <= 0) return;
  reinjectTimer = setInterval(() => {
    try { checkAndInject(context, { interactive: false }); } catch (err) { console.error('[Agentville]', err); }
  }, hours * 3600 * 1000);
  // Register the cleanup once; it always clears whatever the current timer is.
  if (!reinjectDisposed) {
    reinjectDisposed = true;
    context.subscriptions.push({ dispose: () => { if (reinjectTimer) clearInterval(reinjectTimer); } });
  }
}

function registerFocusReinject(context) {
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      const now = Date.now();
      if (now - lastFocusCheck < FOCUS_REINJECT_THROTTLE_MS) return;
      lastFocusCheck = now;
      checkAndInject(context, { interactive: false });
    })
  );
}

function handleVersionUpgrade(context) {
  const version = context.extension.packageJSON.version;
  const stored = context.globalState.get('agentville.installedVersion');
  if (stored && stored !== version) checkAndInject(context, { interactive: false });
  context.globalState.update('agentville.installedVersion', version);
}

function offerReload() {
  vscode.window.showInformationMessage(
    'Agentville button injected into the Claude Code panel. Reload the window to show it.',
    'Reload Window', 'Restart Extension Host'
  ).then((choice) => {
    if (choice === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
    else if (choice === 'Restart Extension Host') vscode.commands.executeCommand('workbench.action.restartExtensionHost');
  });
}

/** Background update check that badges the status bar; controlled by a setting. */
function backgroundUpdateCheck(context) {
  if (!getConfig().get('autoUpdateCheck', true)) return;
  updater.checkForUpdate(vscode, context, {
    interactive: false,
    onResult: (r) => statusBar.reflectUpdate(r.remoteVersion),
  }).catch((err) => console.error('[Agentville] update check failed:', err));
}

/** The status-bar click target: a tiny menu (open town / check for updates). */
async function showMenu(context) {
  const OPEN = '$(rocket) Open Agentville';
  const UPDATE = '$(sync) Check for Updates';
  const pick = await vscode.window.showQuickPick([OPEN, UPDATE], { placeHolder: 'Agentville 🏘️' });
  if (pick === OPEN) openPanel(context);
  else if (pick === UPDATE) updater.checkForUpdate(vscode, context, { interactive: true, onResult: (r) => statusBar.reflectUpdate(r.remoteVersion) });
}

function activate(context) {
  // Register the launch paths FIRST, before anything that can throw (e.g. reading
  // the webview script off disk). onUri can activate this extension via the footer
  // button's deep link, so the UriHandler must exist even if injection later fails.
  statusBar.create(vscode, context);

  context.subscriptions.push(
    vscode.commands.registerCommand('agentville.open', () => openPanel(context)),
    vscode.commands.registerCommand('agentville.checkAndInject', () => {
      const r = checkAndInject(context, { interactive: true });
      if (r.changed > 0) offerReload();
      else vscode.window.showInformationMessage(`Agentville: nothing to update (${r.targets} target(s) already current).`);
    }),
    vscode.commands.registerCommand('agentville.removeInjection', () => {
      const n = removeInjection();
      vscode.window.showInformationMessage(`Agentville: removed injection from ${n} target(s). Reload to apply.`);
    }),
    vscode.commands.registerCommand('agentville.checkForUpdate', () =>
      updater.checkForUpdate(vscode, context, { interactive: true, onResult: (r) => statusBar.reflectUpdate(r.remoteVersion) }),
    ),
    // Status-bar click target (not contributed to the palette to avoid clutter).
    vscode.commands.registerCommand('agentville.menu', () => showMenu(context))
  );

  // The footer button's vscode: deep link arrives here.
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri) {
        // uri.path is "/open" for vscode://orbenozio.agentville-launcher/open?t=<nonce>.
        // The footer button always sends this; the host toggles from the real panel state
        // (the ?t nonce only keeps each openExternal unique so VSCode never coalesces a
        // repeat click). Reveal/close is decided in togglePanel, not by the button.
        const cmd = (uri.path || '').replace(/^\/+/, '').replace(/\/+$/, '');
        if (cmd !== 'open') return;
        togglePanel(context);
      },
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentville.autoInject')) {
        try { checkAndInject(context, { interactive: false }); } catch (err) { console.error('[Agentville]', err); }
      }
      if (e.affectsConfiguration('agentville.reinjectCheckHours')) {
        scheduleReinject(context); // pick up the new interval immediately
      }
    })
  );

  // Injection is best-effort — a failure here must never break the launch paths above.
  try {
    handleVersionUpgrade(context);
    const r = checkAndInject(context, { interactive: false });
    if (r.changed > 0) offerReload();
    scheduleReinject(context);
    registerFocusReinject(context);
  } catch (err) {
    console.error('[Agentville] injection setup failed:', err);
    statusBar.reflect({ changed: 0, targets: 0 });
  }

  // Independent of injection: a hand-installed VSIX has no marketplace auto-update,
  // so check GitHub for a newer release on startup (throttled to once a day).
  backgroundUpdateCheck(context);
}

function deactivate() {
  if (reinjectTimer) clearInterval(reinjectTimer);
}

module.exports = { activate, deactivate };
