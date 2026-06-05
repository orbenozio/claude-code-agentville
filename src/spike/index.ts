import { promises as fs } from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import { normalizeLine } from "../core/normalize.js";
import { StateReducer, type StateChange } from "../core/Reducer.js";
import { TailReader } from "../core/TailReader.js";
import { discoverSessions, hottestSession } from "./discovery.js";

const STATE_EMOJI: Record<string, string> = {
  idle: "🏠",
  working: "🏭",
  done: "✅",
  error: "⚠️",
  rateLimited: "😴",
};

function ts(): string {
  return new Date().toLocaleTimeString();
}

function logChange(c: StateChange): void {
  const e = STATE_EMOJI[c.after] ?? "❓";
  const who = c.state.kind === "main" ? "main" : (c.state.type ?? "subagent");
  const task = c.state.task ? ` — "${truncate(c.state.task, 60)}"` : "";
  const from = c.before ? `${c.before}→` : "";
  console.log(`[${ts()}] ${e} ${who} (${short(c.agentId)}) ${from}${c.after}${task}`);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function short(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

// ---- REPLAY MODE: feed a historical file through the pipeline deterministically ----
async function runReplay(file: string): Promise<void> {
  console.log(`\n=== REPLAY: ${file} ===\n`);
  const sessionId = path.basename(file, ".jsonl");
  const fileAgentId = parseAgentIdFromPath(file);
  // simulated monotonic clock = latest event timestamp seen, for deterministic replay
  let simNow = 0;
  const reducer = new StateReducer(() => simNow);

  const content = await fs.readFile(file, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  let normalized = 0;
  let unknown = 0;
  for (const line of lines) {
    const recs = normalizeLine(line, { sessionId, fileAgentId });
    for (const r of recs) {
      if (r.kind === "unknown") unknown++;
      else normalized++;
      if (r.ts > simNow) simNow = r.ts;
      for (const c of reducer.apply(r)) logChange(c);
    }
  }
  // final settle: advance time so anything silent goes idle
  simNow = Number.MAX_SAFE_INTEGER / 2;
  for (const c of reducer.tick()) logChange(c);

  console.log(`\n--- replay summary ---`);
  console.log(`raw lines:        ${lines.length}`);
  console.log(`normalized recs:  ${normalized}`);
  console.log(`unknown recs:     ${unknown}`);
  console.log(`agents tracked:   ${reducer.snapshot().length}`);
  for (const a of reducer.snapshot()) {
    console.log(`  ${STATE_EMOJI[a.state]} ${a.kind}/${a.type ?? "?"} ${short(a.agentId)} state=${a.state}${a.task ? ` task="${truncate(a.task, 50)}"` : ""}`);
  }
}

function parseAgentIdFromPath(file: string): string | undefined {
  const m = /agent-([a-z0-9]+)\.jsonl$/i.exec(path.basename(file));
  return m?.[1];
}

// ---- LIVE MODE: tail the hottest session + its subagents in real time ----
async function runLive(projectFilter?: string): Promise<void> {
  const session = await hottestSession(projectFilter);
  if (!session) {
    console.error("No sessions found under ~/.claude/projects");
    process.exit(1);
  }
  console.log(`\n=== LIVE: ${session.projectDir}`);
  console.log(`    session ${session.sessionId}`);
  console.log(`    tailing main + subagents (Ctrl+C to stop)\n`);

  const reducer = new StateReducer();
  const readers = new Map<string, { reader: TailReader; agentId?: string }>();

  const addReader = (file: string, agentId?: string, fromTail = true) => {
    if (readers.has(file)) return;
    readers.set(file, { reader: new TailReader(file, fromTail ? 64 * 1024 : 0), agentId });
  };
  addReader(session.mainFile, undefined, true);

  const pump = async () => {
    for (const { reader, agentId } of readers.values()) {
      const lines = await reader.poll();
      for (const line of lines) {
        for (const r of normalizeLine(line, { sessionId: session.sessionId, fileAgentId: agentId })) {
          for (const c of reducer.apply(r)) logChange(c);
        }
      }
    }
  };

  // watch main file for growth
  const watcher = chokidar.watch(session.mainFile, {
    persistent: true,
    usePolling: true, // SPEC.md §4 — polling fallback is mandatory
    interval: 300,
  });
  watcher.on("change", () => void pump());

  // watch subagents dir for new agent files
  const saWatcher = chokidar.watch(session.subagentsDir, {
    persistent: true,
    usePolling: true,
    interval: 300,
    ignoreInitial: false,
  });
  saWatcher.on("add", (file) => {
    const agentId = parseAgentIdFromPath(file);
    if (agentId) {
      console.log(`[${ts()}] 👀 new subagent file: agent-${short(agentId)}`);
      addReader(file, agentId, false);
      void pump();
    }
  });
  saWatcher.on("change", () => void pump());

  // idle tick
  setInterval(() => {
    for (const c of reducer.tick()) logChange(c);
  }, 5000);

  await pump(); // initial read of the tail
  console.log(`[${ts()}] watching… current agents: ${reducer.snapshot().length}`);

  const secondsArg = process.argv[process.argv.indexOf("--seconds") + 1];
  const seconds = process.argv.includes("--seconds") ? Number(secondsArg) : 0;
  if (seconds > 0) {
    setTimeout(async () => {
      await watcher.close();
      await saWatcher.close();
      console.log(`\n[${ts()}] auto-exit after ${seconds}s. agents tracked: ${reducer.snapshot().length}`);
      for (const a of reducer.snapshot()) {
        console.log(`  ${STATE_EMOJI[a.state] ?? "❓"} ${a.kind}/${a.type ?? "?"} ${short(a.agentId)} state=${a.state}`);
      }
      process.exit(0);
    }, seconds * 1000);
  }
}

// ---- entry ----
const args = process.argv.slice(2);
if (args.includes("--list")) {
  const sessions = await discoverSessions();
  console.log("Hottest sessions:");
  for (const s of sessions.slice(0, 10)) {
    console.log(`  ${new Date(s.mtimeMs).toLocaleString()}  ${s.projectDir}  (${s.sessionId.slice(0, 8)})`);
  }
} else if (args.includes("--replay")) {
  const fileArg = args[args.indexOf("--replay") + 1];
  const file = fileArg ?? (await hottestSession())?.mainFile;
  if (!file) {
    console.error("No file to replay");
    process.exit(1);
  }
  await runReplay(file);
} else {
  const filterIdx = args.indexOf("--project");
  const filter = filterIdx >= 0 ? args[filterIdx + 1] : undefined;
  await runLive(filter);
}
