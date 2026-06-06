# Agentville 🏘️

A live, top-down **town view of your Claude Code agents** — right inside a VSCode tab.
Every agent becomes a little character with a house around the town square; the main
session is the **mayor** in the town hall, and each sub-agent is a villager whose role
(builder / reviewer / architect / researcher) shows in what they carry. Watch them
work, finish (✅), sleep and dream 💭 — with day/night and live weather over the village.

## Opening it

Three ways, all open the town in a VSCode tab:

- 🌍 the **globe button in the Claude Code panel** footer
- 🌍 the **status-bar item** (`Agentville`)
- the **command palette** → **“Agentville: Open the town view”**

No setup, no separate app to install — it runs entirely inside VSCode.

## Features

- **A character per agent**, placed around the central square; the main session is the
  mayor in the town hall.
- **Village tabs** — signposts on the sides hop between the other Claude conversations
  of the **same project** (each its own “village”), colour-coded, with an optional
  manual name you can set per chat.
- **Day/night + weather** — the village reflects the local time of day, and real
  weather for a city you choose (keyless, via Open-Meteo).
- **Cute life** — farm animals, birds, a flowing river with jumping fish, fruit trees,
  street lamps that light up in the evening.

## How it works

Agentville reads Claude Code’s **local session files** (`~/.claude/projects/…`,
read-only) to know which agents are active, and renders the town in a VSCode webview.
The 🌍 button is added to Claude’s panel by patching Claude Code’s `webview/index.js`
with a **marker-scoped** block that coexists safely with other tools (e.g. Claude Code
Nonstop) — it only ever touches text between its own markers, re-injects after Claude
updates, and on removal strips only its own block.

It reads only; it never modifies your conversations or sends them anywhere.

## Commands

- **Agentville: Open the town view** — open (or focus) the town tab.
- **Agentville: Add button to Claude panel (inject)** — re-add the 🌍 button.
- **Agentville: Remove button from Claude panel** — remove the injection (restores
  Claude’s file by stripping only our markers).

## Settings

- **`agentville.autoInject`** — add the button on startup / after Claude updates (default on).
- **`agentville.reinjectCheckHours`** — how often to re-check the injection (default 6).

## Install (dev / from VSIX)

Install the packaged `.vsix` via **Extensions → … → Install from VSIX**, or copy this
folder to `~/.vscode/extensions/orbenozio.agentville-launcher-<version>/`, then reload
the window. The webview bundle is built by `vscode:prepublish` (esbuild); the host has
no runtime dependencies.
