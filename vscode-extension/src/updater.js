'use strict';

/**
 * Self-update for a VSIX distributed via GitHub Releases (no marketplace auto-update).
 *
 * On activation (throttled to once a day) the extension asks GitHub for the latest
 * release tag, compares it to the running version, and if a newer one exists offers a
 * one-click "Update now" that downloads the stable-named asset and installs it in place.
 * The install link is the convention-based always-latest URL
 *   https://github.com/<owner>/<repo>/releases/latest/download/<name>.vsix
 * so nothing here hard-codes a version.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000; // at most one background check per day
const LAST_CHECK_KEY = 'agentville.lastUpdateCheck';

/** Parse "owner/repo" out of the manifest's repository URL. */
function repoSlug(pkg) {
  const url = (pkg && pkg.repository && (pkg.repository.url || pkg.repository)) || '';
  const m = String(url).match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** GET that follows redirects; resolves with { status, body } (body buffered as utf8). */
function httpsGet(url, headers, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ 'User-Agent': 'agentville-updater' }, headers) }, (res) => {
      const { statusCode } = res;
      if (statusCode >= 300 && statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(httpsGet(next, headers, redirectsLeft - 1));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
  });
}

/** Download a URL (following redirects) to a local file. */
function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'agentville-updater' } }, (res) => {
      const { statusCode } = res;
      if (statusCode >= 300 && statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(download(next, dest, redirectsLeft - 1));
        return;
      }
      if (statusCode !== 200) { res.resume(); reject(new Error(`download failed (HTTP ${statusCode})`)); return; }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', (e) => { fs.unlink(dest, () => reject(e)); });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('download timed out')));
  });
}

/** Numeric semver-ish compare; returns >0 if a is newer than b. Pre-release tags ignored. */
function cmpVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function fetchLatest(slug) {
  const { status, body } = await httpsGet(
    `https://api.github.com/repos/${slug.owner}/${slug.repo}/releases/latest`,
    { Accept: 'application/vnd.github+json' },
  );
  if (status !== 200) throw new Error(`GitHub API HTTP ${status}`);
  const json = JSON.parse(body);
  return { tag: json.tag_name || '', htmlUrl: json.html_url || '', version: String(json.tag_name || '').replace(/^v/, '') };
}

/** Download the always-latest VSIX and install it via VS Code's own installer. */
async function installLatest(vscode, slug, pkg) {
  const url = `https://github.com/${slug.owner}/${slug.repo}/releases/latest/download/${pkg.name}.vsix`;
  const dest = path.join(os.tmpdir(), `${pkg.name}-latest-${Date.now()}.vsix`);
  await download(url, dest);
  await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(dest));
  try { fs.unlinkSync(dest); } catch (_) { /* best effort */ }
}

/**
 * @param {object} vscode
 * @param {object} context  extension context (for packageJSON + globalState throttle)
 * @param {object} opts     { interactive } - interactive shows "up to date"/errors; the
 *                          background path is silent and throttled to once a day.
 */
async function checkForUpdate(vscode, context, opts = {}) {
  const interactive = !!opts.interactive;
  const pkg = context.extension.packageJSON;
  const slug = repoSlug(pkg);
  if (!slug) { if (interactive) vscode.window.showWarningMessage('Agentville: no GitHub repository configured to check for updates.'); return; }

  if (!interactive) {
    const last = context.globalState.get(LAST_CHECK_KEY, 0);
    if (Date.now() - last < CHECK_THROTTLE_MS) return;
    context.globalState.update(LAST_CHECK_KEY, Date.now());
  }

  let latest;
  try {
    latest = await fetchLatest(slug);
  } catch (e) {
    if (interactive) vscode.window.showErrorMessage(`Agentville: update check failed - ${e.message}`);
    return;
  }

  const updateAvailable = !!latest.version && cmpVersions(latest.version, pkg.version) > 0;
  // Let the caller reflect the result (e.g. badge the status bar) regardless of choice.
  if (typeof opts.onResult === 'function') {
    try { opts.onResult({ localVersion: pkg.version, remoteVersion: latest.version, updateAvailable }); } catch (_) { /* non-fatal */ }
  }

  if (!updateAvailable) {
    if (interactive) vscode.window.showInformationMessage(`Agentville is up to date (v${pkg.version}).`);
    return;
  }

  const UPDATE = 'Update now';
  const NOTES = 'Release notes';
  const choice = await vscode.window.showInformationMessage(
    `Agentville v${latest.version} is available (you have v${pkg.version}).`,
    UPDATE, NOTES, 'Later',
  );
  if (choice === NOTES) { if (latest.htmlUrl) vscode.env.openExternal(vscode.Uri.parse(latest.htmlUrl)); return; }
  if (choice !== UPDATE) return;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Updating Agentville to v${latest.version}…` },
      () => installLatest(vscode, slug, pkg),
    );
  } catch (e) {
    // Fall back to a manual download if the programmatic install path is unavailable.
    const OPEN = 'Open download';
    const c = await vscode.window.showErrorMessage(`Agentville: auto-install failed - ${e.message}`, OPEN);
    if (c === OPEN) vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${slug.owner}/${slug.repo}/releases/latest`));
    return;
  }

  const RELOAD = 'Reload Window';
  const c = await vscode.window.showInformationMessage(`Agentville updated to v${latest.version}. Reload to finish.`, RELOAD);
  if (c === RELOAD) vscode.commands.executeCommand('workbench.action.reloadWindow');
}

module.exports = { checkForUpdate, cmpVersions, repoSlug };
