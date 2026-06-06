# Launcher plan — open Agentville from a button in the Claude Code panel

Goal: a 🌍 globe button inside the **Claude Code panel footer** (in a shared,
reusable toolbar `<div>`) that, when clicked, opens the Agentville desktop app.
Mirror the proven mechanism of the existing **NONSTOP** extension
(`orbenozio.claude-code-nonstop-0.2.3`), and coexist with it.

## Why this shape
The button must live inside Claude's webview (a sandboxed browser context). A
DOM script there can manipulate the DOM but **cannot spawn a process**. NONSTOP
sidesteps this because it only ever types into Claude's input — it never needs
the host. We *do* need to launch an external app, so we need a webview→host
bridge that a sandboxed page is actually allowed to use.

### Launch-bridge options (the key decision)
| Option | Verdict |
| --- | --- |
| `command:agentville.open` URI | ✗ disabled unless Claude's webview sets `enableCommandUris` (we don't control it; almost certainly off). |
| custom scheme `agentville://open` | ✗ webviews block navigation to unknown schemes. |
| `vscode://orbenozio.agentville-launcher/open` | ✓ `vscode:` is a VSCode-handled scheme the webview allows; routes back to VSCode → our registered `UriHandler`. **Chosen.** |
| status-bar item + command palette | ✓ always works; ships as the robust fallback regardless. |

## Components

### 1. `agentville-launcher` VSCode extension (new, in `vscode-extension/`)
Reuses NONSTOP's injection machinery (own markers, idempotent, coexisting):
- **Injector** (ported from nonstop `injector.js`): two-sided markers
  `// >>> Agentville Launcher (injected) vX >>>` … `// <<< Agentville Launcher (injected) <<<`.
  `stripAllBlocks` only removes *our* markers → never touches the NONSTOP block.
- **Targets** (ported from `targets/claude-code.js`): find Claude's active
  `webview/index.js`.
- **atomicWrite** (ported): write + verify with retries.
- On `activate`: inject/refresh, re-inject on window focus (throttled) and on
  version upgrade — same lifecycle as nonstop.
- **`registerUriHandler`**: on `/open` → spawn the app.
- **command `agentville.open`** (palette) → spawn the app.
- **status-bar item** `$(globe) Agentville` → command `agentville.open` (fallback).
- **spawn**: clear `ELECTRON_RUN_AS_NODE`, then run the app. App location from a
  setting `agentville.appPath` (default = this repo path). Reuse the exact
  approach in `scripts/launch.mjs` (resolve the electron binary, spawn
  `dist/main.cjs`). Detached so it outlives the extension host.

### 2. Injected webview script (`webview/agentville.js`)
IIFE; guards double-injection (`window.__AGENTVILLE_ACTIVE__`).
- **`ensureToolbar()` — the shared-DIV convention**: look for `#orb-tools`.
  - exists → reuse it (do **not** recreate).
  - missing → create it and dock it in the footer (left of Claude's native mode
    button `[class*="footerButtonPrimary_"]`, exactly where nonstop docks; fall
    back to footer end).
- Append a `#agentville-btn` (inline-SVG globe, `currentColor`) into `#orb-tools`;
  guard against duplicates.
- **click** → navigate to `vscode://orbenozio.agentville-launcher/open`
  (via an `<a>` element click / `window.location.href`).
- Re-inject on an interval (footer re-renders), like nonstop's `setInterval(injectButton, 1500)`.
- Never let our own nodes count as Claude signals (N/A here — we don't detect
  state — but keep ids namespaced).

### 3. Electron app single-instance (`src/main/main.ts`)
- `app.requestSingleInstanceLock()`: if the button is clicked while the app is
  already open, focus the existing window instead of opening a second one
  (`second-instance` → restore + focus `win`).

## Coexistence guarantees
- Our injector only edits text between *our* markers; nonstop only edits text
  between *its* markers (verified: `findBlocks`/`stripAllBlocks` are marker-scoped).
- Separate backup suffix (`.agentville-backup`, distinct from `.nonstop-backup`).
- We never touch `extension.js`, only `webview/index.js`.
- The shared `#orb-tools` div is created-if-absent so multiple tools stack in one
  container; nonstop keeps its own `#nonstop-nav` for now (no nonstop edits).

## Risks / open questions for review
1. Does Claude's webview actually allow navigating to a `vscode://` URI from an
   injected `<a>`/`window.location`? If blocked, the status-bar + palette
   fallback still works; confirm and document.
2. Single-instance lock interaction with the existing `npm start` dev flow.
3. Spawn path resolution when the extension runs from `~/.vscode/extensions`
   vs. dev — resolve the electron binary + app dir robustly.
4. Idempotency/coexistence with nonstop under focus-reinject churn.
