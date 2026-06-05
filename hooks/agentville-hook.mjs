#!/usr/bin/env node
// Agentville hook bridge.
// Claude Code invokes this with a hook payload on stdin (see SPEC §6.3 / hooks docs).
// It appends one compact event line to ~/.claude/agentville/events.jsonl, which
// Agentville tails as its authoritative second data channel.
//
// Register in settings.json (idempotent install — see SPEC §6.3). Safe & passive:
// it only reads stdin and appends to its own file; it never blocks Claude Code
// (always exits 0, prints nothing to stdout).

import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OUT_DIR = path.join(os.homedir(), ".claude", "agentville");
const OUT_FILE = path.join(OUT_DIR, "events.jsonl");

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function compact(payload) {
  const e = payload?.hook_event_name;
  const base = {
    source: "hook",
    event: e,
    sessionId: payload?.session_id,
    ts: new Date().toISOString(),
  };
  switch (e) {
    case "SubagentStart":
      return { ...base, agentId: payload.subagent_id, type: payload.subagent_type ?? payload.agent_type };
    case "SubagentStop":
      return {
        ...base,
        agentId: payload.subagent_id,
        type: payload.subagent_type ?? payload.agent_type,
        exitStatus: payload.exit_status,
      };
    case "Notification":
      return { ...base, notificationType: payload.notification_type, message: payload.message };
    case "PermissionRequest":
      return { ...base, toolName: payload.tool_name, permissionRule: payload.permission_rule };
    case "StopFailure":
      return { ...base, errorType: payload.error_type };
    default:
      return base; // unknown event — still recorded for forensics
  }
}

async function main() {
  try {
    const raw = await readStdin();
    const payload = raw.trim() ? JSON.parse(raw) : {};
    await mkdir(OUT_DIR, { recursive: true });
    await appendFile(OUT_FILE, JSON.stringify(compact(payload)) + "\n", "utf8");
  } catch {
    // never disrupt Claude Code, even on malformed input
  }
  process.exit(0);
}

await main();
