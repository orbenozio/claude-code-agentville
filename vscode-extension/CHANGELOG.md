# Changelog

## 0.1.8

- Actually fix the collapse-to-corner recovery. 0.1.7 still left the village stacked in
  the corner for a few seconds after showing a hidden tab, because the relayout reused
  Pixi's stale screen size (a VS Code webview doesn't fire a window resize when only the
  panel changes). The renderer now measures the real panel box and resizes itself, on
  both the container observer and the visibility event, so the town snaps back the moment
  the panel has its dimensions.

## 0.1.7

- Fix the village collapsing into the top-left corner after the panel was hidden
  behind another tab. The layout now guards against a zero-size canvas, observes the
  panel container for resizes, and re-lays-out the town when the panel becomes visible
  again (no more nudging the window to bring it back).
- Pause the spawn/redraw timers and the render loop while the panel is hidden, so
  critters and fish don't pile up off-screen and spike when you come back.
- Accessibility: the canvas now exposes a live text summary of the village, the chat
  signposts have keyboard-reachable navigation buttons, and important state changes
  (approval, error, rate-limit, done) are announced.
- A quiet, agent-less village now shows a "waiting for agents" hint instead of looking
  like it failed to load, and the entrance curtain can't get stuck if the first load
  hangs.
- Crowded runs lay the houses out in concentric rings and the working agents in a grid
  that stays inside the factory; long agent names are truncated; the HUD keeps its
  contrast and the settings panel scrolls on a small window.

## 0.1.6

- Village signposts now cycle only the most-recently-active conversations in the project
  (not all of them), with a "Villages to cycle" control in the settings popup (default 6).
- Reorganised the settings popup into three sections: Town & villages, Critters & nature,
  Weather & time.

## 0.1.5

- Bundle Pixi again (offline-capable, no network needed for the town). Distributed via
  VSIX / GitHub releases. (The VS Marketplace content scan rejects this extension either
  way — bundled Pixi trips the code-pattern scan, and loading Pixi from a CDN trips the
  remote-code rule — so it isn't published there.)

## 0.1.4

- Load Pixi from a CDN (import map) instead of bundling it, so the extension can be
  published to the VS Marketplace (the bundled Pixi tripped the content scan). The
  town view now needs network access to load the renderer.

## 0.1.3

- Add an extension icon.

## 0.1.2

- The town now renders **inside a VSCode webview tab** (self-contained — no external
  app, no path to configure, cross-platform). The core reads Claude's local session
  files and streams updates to the view.
- **Village tabs**: signposts switch between the other Claude conversations of the same
  project, each a colour-coded village with an optional manual name; the town-hall roof
  and HUD show the current village's colour.
- **Entrance animation**: cloud curtains part to reveal the town.
- Visual polish: thought/dream bubbles render above roofs; dream timing is randomised
  per agent; agent houses are distributed on the left/right of the square (centre top
  kept for the town hall, centre bottom for the welcome sign); flowers are a stable
  random scatter.
- Robustness: switching villages can no longer leak the previous village's agents;
  guards for a sandboxed webview (CSP-safe Pixi init, safe localStorage).

## 0.1.1

- Fix an infinite "Reload Window" notification loop that occurred when both
  Agentville and Claude Code Nonstop were injected into Claude Code's
  `webview/index.js`. Injection is now **in-place**: an existing block is
  replaced where it sits instead of being stripped and re-appended to the end of
  the file. When two injectors both appended-to-end, each reload shoved both
  blocks around, so both files always read as "changed" and both kept offering a
  reload. Re-injecting an already up-to-date block is now a byte-for-byte no-op.
- Add regression tests covering in-place re-injection (no-op with a foreign
  block before/after ours) and in-place updates (version/body change without
  moving a foreign block).

## 0.1.0

- Open Agentville in a VSCode tab, with a 🌍 button in the Claude panel and the
  status bar.
