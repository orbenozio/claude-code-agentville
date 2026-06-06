# Changelog

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
