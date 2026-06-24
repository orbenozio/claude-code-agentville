# Changelog

## 0.1.17

- The footer button is a lit toggle again, by request. It now keeps an optimistic green
  "lit" state and is the source of truth: each click flips the state, lights/dims the
  button, and tells the host the desired state via `on=1`/`on=0`, which the host obeys
  (open when on, close when off) so button and panel stay in lockstep.
- Closing the town tab by hand can't dim the button (there is no host->webview channel),
  so it stays lit until the next click; that click sends `on=0`, the host sees it is
  already closed and just clears the stale lit without reopening, and the click after that
  reopens. Opening via the status bar or a second VSCode window won't light the button for
  the same reason - the lit state reflects this button's own clicks.

## 0.1.16

- Lighter on the machine while the town is live. The session file-watchers now poll the
  busy main log a bit less often and the subagents folder noticeably less often (it was the
  priciest watch), so the village competes less with Claude for the shared host.
- Fewer needless redraws: the town only rebuilds its scene on the hourly sky refresh when
  the time of day actually changes bands, and a burst of agent updates is now applied in a
  single batched pass instead of one full re-layout per change.
- Internal cleanup: migrated the renderer off a deprecated Pixi v8 fill API and tightened
  the standalone window's content-security policy. No visible change.

## 0.1.15

- Make the footer button a reliable open/close toggle. It previously guessed the town's
  state and sent `on=1`/`on=0`, which desynced the moment you closed the tab by hand (the
  button then never reopened it), and a repeated click could be coalesced by VSCode so the
  tab wouldn't close. Now the button just sends a per-click unique URI and the HOST toggles
  from the real panel state: open when closed, close when open. Manual closes can no longer
  wedge it, and the second click always closes. (The optimistic green "lit" indicator was
  dropped — without a host→webview channel it could only ever guess, and would invert after
  a manual close; the button now relies on hover/active feedback.)

## 0.1.14

- Fix the toggle landing one click late (icon lit but nothing opened; the next click
  opened/closed the wrong thing). The click handler called `applyLit()`, which rewrote the
  link's `href` to the *next* click's state — and it ran before VSCode's link interceptor
  read the href, so every open/close was off by one. The href is now aimed at the current
  activation's state on pointer/key DOWN only, and `applyLit()` touches the lit class
  exclusively. First click opens, next click closes, cleanly.

## 0.1.13

- The footer button finally opens the town without blanking Claude's chat. Claude's
  webview is a locked-down sandbox (`frame-src 'self'`, no `allow-popups`), so every
  programmatic channel is blocked: a hidden iframe is CSP-blocked, `window.open` is
  popup-blocked, and a *synthesized* anchor click arrives with `event.view === null` so
  VSCode's link interceptor bails and the frame self-navigates to the vscode: URI,
  blanking the chat. The fix: make the 🌍 button itself a real `<a href="vscode://…">` so
  a genuine user click is intercepted by VSCode and opened via `env.openExternal` →
  UriHandler → `openPanel`. The href is kept aimed at the next desired toggle state
  (open when off, close when on) via `pointerdown`, and the click is left un-prevented so
  VSCode can handle it.

## 0.1.12

- Actually stop the footer button from blanking Claude's chat. The root cause was
  webview-side, not host-side: clicking the injected `<a href="vscode://…">` navigated
  Claude's own top frame to the vscode: URI, blanking the chat ("the renderer
  disappears"). (Proof it was never the panel host: opening the same `openPanel` from the
  status-bar item always worked.) The deep link is now aimed at a throwaway hidden
  `<iframe>` via a named anchor target — `env.openExternal` still fires (→ UriHandler →
  openPanel), but the navigation is contained to the sink frame and the chat frame is
  never touched.

## 0.1.11

- Fix the footer button no longer opening the town. 0.1.10 added `target="_blank"` to the
  injected deep-link anchor to stop it blanking Claude's chat — but for a `vscode:` URL
  `_blank` prevents the click from reaching `env.openExternal`, so the deep link never
  fired and the button only toggled its lit state. Reverted to a plain same-frame anchor
  click (which VSCode routes to `openExternal` → our UriHandler → `openPanel`, the same
  method the status-bar item calls). The chat-blanking that 0.1.10 was really worried
  about is already prevented by the extension-host guards in `panel.js`, so `_blank` was
  both unnecessary and breaking.

## 0.1.10

- Fix the footer button blanking Claude Code's chat. Clicking the 🌍 button injected into
  the Claude panel synthesized an `<a href="vscode://…">` click with no `target`, which
  navigated Claude's own webview top frame to the vscode: URI — a scheme the sandboxed
  page can't load — blanking the chat ("the renderer dies") while the deep link never
  reached the host, so the town didn't open. (Opening from the status-bar item kept
  working because it calls the host command directly, with no webview navigation — the
  clue that pinned this down.) The anchor is now `target="_blank"`, routed through the
  host's external-link handler, and the destructive `window.location.href` fallback is
  removed.
- Harden the town panel so it can never take down Claude Code's own chat. Opening the
  panel (most reproducibly with no folder open, where the panel auto-attaches to the
  globally hottest session) could throw an unhandled rejection in the shared extension
  host — blanking Claude's chat webview and leaving the town unable to open, recoverable
  only by reloading the conversation. The whole activateTarget path, the webview message
  handler, every postMessage (via a new safePost helper), and the async monitor.resume()
  on view-state changes are now wrapped, so a failure leaves a stable empty town instead
  of rippling into the host.

## 0.1.9

- Scope the town to the current VS Code window's workspace. With several windows open,
  the panel showed whichever conversation was globally hottest instead of this window's
  chat; it now picks the hottest Claude session belonging to this window's workspace
  folder, and leaves the town empty rather than borrowing an unrelated window's chat.
- The footer button in the Claude panel is now a lit toggle: it stays highlighted while
  the town is open and toggles it closed on the next click, matching the shared
  #orb-tools toolbar convention.
- The status-bar item shows the running version (e.g. "Agentville v0.1.9").
- Self-update for the GitHub-distributed VSIX: on startup (at most once a day) the
  extension checks GitHub for a newer release and offers a one-click "Update now" that
  installs the latest build in place. The status bar badges when an update is available,
  and a new "Agentville: Check for Updates" command plus an "agentville.autoUpdateCheck"
  setting let you check on demand or disable the startup check.

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
