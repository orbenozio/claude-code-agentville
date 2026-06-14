'use strict';

let statusBarItem;

/**
 * A status-bar globe that launches Agentville. This is the GUARANTEED launch path
 * (the footer button inside Claude's panel is the nicer UX, but its vscode: deep
 * link can be blocked depending on the VS Code build — see LAUNCHER-PLAN review).
 * The tooltip also reflects host-side injection status.
 */
function create(vscode, context) {
  const version = context.extension.packageJSON.version;
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'agentville.open';
  statusBarItem.text = `$(globe) Agentville v${version}`;
  statusBarItem.tooltip = 'Open Agentville 🏘️ (live town view of your Claude agents)';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  return statusBarItem;
}

/**
 * Reflect the result of a checkAndInject pass in the tooltip (the command stays
 * "agentville.open" regardless so the click always launches the app).
 * @param {{changed:number, targets:number}} r
 */
function reflect(r) {
  if (!statusBarItem) return;
  if (!r || r.targets === 0) {
    statusBarItem.tooltip = 'Open Agentville 🏘️ — note: no Claude Code panel found to add the footer button to.';
  } else if (r.changed > 0) {
    statusBarItem.tooltip = 'Open Agentville 🏘️ — footer button injected; reload the Claude window to show it.';
  } else {
    statusBarItem.tooltip = 'Open Agentville 🏘️ (footer button active in the Claude panel).';
  }
}

module.exports = { create, reflect };
