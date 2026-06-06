# Changelog

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
