# Marketplace port — Agentville as a self-contained VSCode extension

Turn Agentville from "a VSCode button that launches an external Electron app" into
a **self-contained, downloadable extension** that renders the town **inside a VSCode
webview panel**. No Electron, no per-user path, cross-platform, one-click install.

## Architecture

```
Claude panel footer 🌍 button  ─(vscode://…/open)→  UriHandler ┐
status-bar 🌍 / command palette ─────────────────────────────→ ├─→ command "agentville.open"
                                                               ┘        │
                                                                        ▼
                                              AgentvillePanel (extension host)
                                              ├─ creates a WebviewPanel (a VSCode tab)
                                              ├─ SessionMonitor (core pipeline, Node)
                                              │     onChanges → webview.postMessage('agent-diff')
                                              ├─ session-info on start
                                              └─ onDidReceiveMessage: getSnapshot / getWeather
                                                                        │ postMessage
                                                                        ▼
                                              Webview (browser context)
                                              ├─ shim.js: provides window.agentville over
                                              │   acquireVsCodeApi()+postMessage (renderer
                                              │   stays UNCHANGED — 4 call sites)
                                              └─ renderer.js (Pixi town) + index.html (+CSP)
```

### Why this is generic
- The renderer already runs in any browser context → a VSCode webview IS one.
- The core (`TailReader`/`normalize`/`Reducer`/`SessionMonitor`/`discovery`) is pure
  Node → runs in the extension host exactly as it did in Electron main.
- `postMessage` here is the *sanctioned* webview API (it's OUR webview, not Claude's).
- Removed entirely: `appPath`, the spawn/launch bridge, `electron` dependency, the
  single-instance lock, per-OS binaries.

### The renderer is untouched
Its only host coupling is `window.agentville.{onAgentDiff,onSessionInfo,getSnapshot,
getWeather}` (renderer.ts:269,1363,1367,1371). A webview shim implements that exact
interface over postMessage, so renderer.ts needs **no logic changes**.

## The Claude-panel button stays
Kept as a primary entry point (precedent: the user's published NONSTOP extension
injects the same way). It now just triggers `agentville.open` (which opens the panel)
— no external launch. Status-bar item + command palette are the guaranteed fallback.

## Phases
1. **Webview side** — `shim.js` (window.agentville over postMessage) + `index.html`
   template with a strict CSP and `asWebviewUri` placeholders.
2. **Panel host** — `AgentvillePanel`: create/reveal a singleton WebviewPanel, own a
   `SessionMonitor`, pump diffs + session-info, answer getSnapshot/getWeather requests,
   dispose the monitor on panel close.
3. **Rewire action** — `extension.js` `agentville.open` → open the panel (delete
   `launch.js`, `appPath`, spawn). Keep injection + UriHandler + status bar.
4. **Build** — esbuild: bundle the core/monitor → `dist/monitor.cjs` (host), bundle the
   renderer → `media/renderer.js` (webview), copy/emit `media/index.html` + `media/shim.js`.
   `chokidar` stays a runtime dep (vsce bundles node_modules); fsevents is optional.
5. **Run + verify** (sub-agent code review), then **branding + marketplace metadata**
   (generic publisher/icon/README-in-extension/LICENSE/galleryBanner), then **vsce
   package + publish** (use the `ship-vscode-extension` skill for the PAT/publish gotchas).

## De-user-specific cleanup
- Remove `agentville.appPath`; revert the global VSCode settings.json entry.
- Generic ids/branding; no hard-coded local paths anywhere.
- Weather city stays a user setting (already generic, defaults off).

## Open risks
- Webview CSP: Pixi uses WebGL + (maybe) blob workers; set `script-src ${cspSource}`,
  `img-src ${cspSource} data:`, `style-src ${cspSource} 'unsafe-inline'`. Verify Pixi
  boots under it (fallback: canvas renderer).
- Extension-host `fetch` for weather (Node 18+ in VSCode — confirm) else use https.
- Bundling `chokidar`/native `fsevents` into the vsix (mac). Option: replace chokidar
  with a fs.stat polling watcher to make the extension dependency-free (it already polls).
```
