// End-to-end check of the HOOKS channel (SPEC §6.3 / spike-0 ש2).
// Drives the real hook script (hooks/agentville-hook.mjs) exactly as Claude Code
// would — piping hook payloads to its stdin — then tails the resulting
// events.jsonl through the parser + reducer. Proves the channel mechanically;
// the only thing it can't do is make a *real* Claude Code session fire the hooks.
//
// Run: npx tsx src/spike/hookcheck.ts
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeHookLine } from "../core/normalize.js";
import { StateReducer } from "../core/Reducer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.join(here, "..", "..", "hooks", "agentville-hook.mjs");
const EVENTS_FILE = path.join(os.homedir(), ".claude", "agentville", "events.jsonl");

function assert(cond: boolean, msg: string): void {
  console.log(`${cond ? "✅" : "❌"} ${msg}`);
  if (!cond) process.exitCode = 1;
}

/** invoke the hook script with a payload on stdin, exactly as Claude Code does */
function fireHook(payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT], { stdio: ["pipe", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", () => resolve());
    child.stdin.end(JSON.stringify(payload));
  });
}

async function main(): Promise<void> {
  // start clean so we read only what this run produced
  await fs.rm(EVENTS_FILE, { force: true });

  // realistic payloads built from the documented hook schemas
  const sid = "test-session-abc";
  await fireHook({ hook_event_name: "SubagentStart", session_id: sid, subagent_id: "aabbccddee01", subagent_type: "architect", agent_type: "architect" });
  await fireHook({ hook_event_name: "Notification", session_id: sid, notification_type: "permission_prompt", message: "Claude needs permission to run Bash" });
  await fireHook({ hook_event_name: "PermissionRequest", session_id: sid, tool_name: "Bash", permission_rule: "Bash(npm *)" });
  await fireHook({ hook_event_name: "Notification", session_id: sid, notification_type: "idle_prompt", message: "Claude is waiting for your input" });
  await fireHook({ hook_event_name: "StopFailure", session_id: sid, error_type: "rate_limit", error_message: "Rate limit exceeded" });
  await fireHook({ hook_event_name: "SubagentStop", session_id: sid, subagent_id: "aabbccddee01", subagent_type: "architect", exit_status: "success" });

  // read back what the hook script wrote
  let raw = "";
  try {
    raw = await fs.readFile(EVENTS_FILE, "utf8");
  } catch {
    assert(false, `events.jsonl was created at ${EVENTS_FILE}`);
    return;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  assert(lines.length === 6, `hook script appended all 6 events (got ${lines.length})`);
  console.log("\n--- events.jsonl (written by the real hook script) ---");
  for (const l of lines) console.log("  " + l);

  // run them through the Agentville hook parser + reducer
  console.log("\n--- parser + reducer ---");
  let simNow = 0;
  const reducer = new StateReducer(() => simNow);
  const notes: string[] = [];
  let sawWorking = false;
  let sawDone = false;
  let sawRateLimited = false;
  for (const line of lines) {
    const { records, info } = normalizeHookLine(line);
    if (info) {
      notes.push(info);
      console.log(`  ℹ️  ${info}`);
    }
    for (const r of records) {
      if (r.ts > simNow) simNow = r.ts;
      for (const c of reducer.apply(r)) {
        console.log(`  ${c.before ?? "∅"}→${c.after}  ${c.state.kind}/${c.state.type ?? "?"} ${c.agentId.slice(0, 10)}`);
        if (c.after === "working") sawWorking = true;
        if (c.after === "done") sawDone = true;
        if (c.after === "rateLimited") sawRateLimited = true;
      }
    }
  }

  console.log("");
  assert(sawWorking, "SubagentStart (hook) → agent enters working, type resolved from hook");
  assert(sawDone, "SubagentStop (hook) → agent reaches done");
  assert(
    notes.some((n) => n.includes("permission_prompt")) && notes.some((n) => n.includes("idle_prompt")),
    "Notification permission_prompt + idle_prompt captured with their fields (⏳ / 🏠 channel proven)",
  );
  assert(notes.some((n) => n.includes("permission_request tool=Bash")), "PermissionRequest captured with tool name");
  assert(sawRateLimited, "StopFailure error_type=rate_limit → 😴 rateLimited (hook error channel wired, not dropped)");

  // tidy up the test events file
  await fs.rm(EVENTS_FILE, { force: true });
}

await main();
