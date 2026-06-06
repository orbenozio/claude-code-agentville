'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Launch the Agentville Electron app from the VS Code extension host.
 *
 * Critical details (see LAUNCHER-PLAN review B2):
 *  - The electron binary is resolved relative to the configured app path, NOT the
 *    extension dir — the extension lives in ~/.vscode/extensions and has no
 *    electron of its own. We createRequire() rooted at <appPath> so require()
 *    finds the app's own node_modules/electron (the correct platform build).
 *  - ELECTRON_RUN_AS_NODE is cleared — the extension host sets it, and leaving it
 *    on makes the spawned electron run as plain Node (require('electron') returns
 *    a path string and the app never boots).
 *  - detached + stdio:'ignore' + unref so the app outlives extension-host reloads
 *    and isn't tied to a (nonexistent) terminal.
 *  - A short debounce coalesces rapid double-clicks into one spawn; the app's own
 *    single-instance lock then focuses the existing window for any extra launches.
 */

let lastLaunchAt = 0;
const DEBOUNCE_MS = 1500;

/** Resolve { electronExe, mainEntry } from the app path, or throw a clear error. */
function resolveApp(appPath) {
  if (!appPath) {
    throw new Error('Agentville app path is not set (agentville.appPath).');
  }
  const root = path.resolve(appPath);
  if (!fs.existsSync(root)) {
    throw new Error(`Agentville app path does not exist: ${root}`);
  }
  const mainEntry = path.join(root, 'dist', 'main.cjs');
  if (!fs.existsSync(mainEntry)) {
    throw new Error(`Built app not found at ${mainEntry}. Run "npm run build" in the Agentville repo first.`);
  }
  // Resolve electron's binary by READING node_modules/electron/path.txt — NOT via
  // require('electron'). Inside the VS Code extension host (itself an Electron
  // process) require('electron') is shadowed by Electron's built-in main-process API
  // object, not the npm package that exports the binary path string — that's what
  // produced "[object Object]". path.txt holds the exe name relative to dist/.
  const electronPkgDir = path.join(root, 'node_modules', 'electron');
  const pathTxt = path.join(electronPkgDir, 'path.txt');
  let electronExe;
  try {
    const exeRel = fs.readFileSync(pathTxt, 'utf8').trim();
    electronExe = path.isAbsolute(exeRel) ? exeRel : path.join(electronPkgDir, 'dist', exeRel);
  } catch (e) {
    throw new Error(`Could not find electron in ${root} (missing node_modules/electron/path.txt). Run "npm install" in the Agentville repo. (${e.message})`);
  }
  if (!fs.existsSync(electronExe)) {
    throw new Error(`Electron binary not found at ${electronExe}. Run "npm install" in the Agentville repo.`);
  }
  return { root, electronExe, mainEntry };
}

/**
 * Spawn (or focus, via the app's single-instance lock) the Agentville app.
 * @param {string} appPath  absolute path to the Agentville repo
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function launchAgentville(appPath) {
  const now = Date.now();
  if (now - lastLaunchAt < DEBOUNCE_MS) {
    return { ok: true }; // coalesce a burst of clicks into the first spawn
  }

  let resolved;
  try {
    resolved = resolveApp(appPath);
  } catch (e) {
    return { ok: false, error: e.message }; // don't debounce a config/build error away
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  try {
    const child = spawn(resolved.electronExe, [resolved.mainEntry], {
      cwd: resolved.root,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    // Spawn failures for a detached child surface ASYNChronously here (not via the
    // throw below). We can't turn that into the {ok:false} we already returned, so
    // at least leave a trace in the extension-host log.
    child.on('error', (err) => { console.error('[Agentville] spawn error:', err && err.message); });
    child.unref();
    lastLaunchAt = now; // only debounce after a spawn actually started
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed to launch Agentville: ${e.message}` };
  }
}

module.exports = { launchAgentville, resolveApp };
