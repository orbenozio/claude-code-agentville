# Agentville Launcher (VSCode extension)

Adds a 🌍 globe button that opens the **Agentville** desktop app — both:

- **In the Claude Code panel footer** (the nice UX), docked into a shared
  `#orb-tools` toolbar div so future tools can stack beside it; and
- **In the VSCode status bar** (`$(globe) Agentville`) — the *guaranteed* launch
  path, since the panel button's deep link can be blocked on some VSCode builds.

## How it works

It mirrors the proven **Claude Code Nonstop** mechanism and coexists with it:

1. On activation it patches Claude Code's `webview/index.js` with a
   **marker-scoped** block (`// >>> Agentville Launcher (injected) … >>>`). Only
   text between *its own* markers is ever touched, so it never clobbers Nonstop's
   block (and vice-versa). Idempotent, re-injects on window focus and after Claude
   updates. An emergency `.agentville-backup` is kept; removal **strips only our
   markers** (never blind-restores).
2. The injected script adds the globe button. Clicking it fires a synthesized
   `<a>` click to `vscode://orbenozio.agentville-launcher/open`.
3. The extension's `UriHandler` (and the `agentville.open` command behind the
   status-bar item) launches the Electron app: it resolves `electron` from the
   app's own `node_modules`, clears `ELECTRON_RUN_AS_NODE`, and spawns
   `dist/main.cjs` detached. The app's single-instance lock focuses an existing
   window instead of opening a second town.

## Setup

1. Build the Agentville app once: `npm run build` in the repo (produces
   `dist/main.cjs`).
2. Set **`agentville.appPath`** to the repo's absolute path. If you have the repo
   open as a workspace folder, it's auto-detected — no setting needed.
3. Reload the VSCode window. The extension injects the button and offers a second
   reload so the Claude panel picks it up.

## Commands

- **Agentville: Open the town view** — launch the app (same as the buttons).
- **Agentville: Add button to Claude panel (inject)** — force a re-inject.
- **Agentville: Remove button from Claude panel** — strip our injection (restores
  Claude's file by removing only our markers).

## Install (dev)

Copy this folder to `~/.vscode/extensions/orbenozio.agentville-launcher-<version>/`
and reload the window. No build step / no dependencies (pure VSCode + Node API).

Run the logic tests: `node test/injector.test.js`.
