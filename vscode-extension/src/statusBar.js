'use strict';

let statusBarItem;
let vscodeRef;
let localVersion = '';
let remoteVersion = '';      // newest version seen from GitHub (empty until checked)
let injectionTip = 'live town view of your Claude agents'; // detail appended to the tooltip

/**
 * A status-bar globe that launches Agentville (and exposes "Check for updates").
 * This is the GUARANTEED launch path (the footer button inside Claude's panel is the
 * nicer UX, but its vscode: deep link can be blocked depending on the VS Code build).
 *
 * The label shows the running version (e.g. "Agentville v0.1.8"); when a newer GitHub
 * release exists it becomes "Agentville v0.1.8 → v0.1.9" on a warning background.
 * Clicking the item opens a small menu (open town / check for updates) - see the
 * `agentville.menu` command.
 */
function create(vscode, context) {
  vscodeRef = vscode;
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'agentville.menu';
  localVersion = (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || '';
  render();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  return statusBarItem;
}

function render() {
  if (!statusBarItem) return;
  const ver = localVersion ? ` v${localVersion}` : '';
  const hasUpdate = remoteVersion && remoteVersion !== localVersion;
  if (hasUpdate) {
    statusBarItem.text = `$(cloud-download) Agentville${ver} → v${remoteVersion}`;
    statusBarItem.tooltip = `Agentville: update available (v${remoteVersion}) - click for options.`;
    statusBarItem.backgroundColor = vscodeRef ? new vscodeRef.ThemeColor('statusBarItem.warningBackground') : undefined;
  } else {
    statusBarItem.text = `$(globe) Agentville${ver}`;
    statusBarItem.tooltip = `Open Agentville 🏘️ - ${injectionTip}`;
    statusBarItem.backgroundColor = undefined;
  }
}

/**
 * Reflect the result of a checkAndInject pass in the tooltip detail (the command stays
 * "agentville.menu" regardless so the click always opens the launch menu).
 * @param {{changed:number, targets:number}} r
 */
function reflect(r) {
  if (!statusBarItem) return;
  if (!r || r.targets === 0) {
    injectionTip = 'note: no Claude Code panel found to add the footer button to';
  } else if (r.changed > 0) {
    injectionTip = 'footer button injected; reload the Claude window to show it';
  } else {
    injectionTip = 'footer button active in the Claude panel';
  }
  render();
}

/** Reflect an update check: badge the item when a newer release exists. */
function reflectUpdate(remote) {
  remoteVersion = remote || '';
  render();
}

module.exports = { create, reflect, reflectUpdate };
