import os from "node:os";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { normalizeHookLine, normalizeLine } from "../core/normalize.js";
import { StateReducer, type StateChange } from "../core/Reducer.js";
import { TailReader } from "../core/TailReader.js";
import type { AgentState } from "../core/types.js";
import { hottestSession, type SessionInfo } from "../spike/discovery.js";

const AGENT_FILE_RE = /agent-([a-z0-9]+)\.jsonl$/i;
// second data channel (SPEC §5.3): hooks write here; we merge it with the JSONL tail.
const HOOK_EVENTS_FILE = path.join(os.homedir(), ".claude", "agentville", "events.jsonl");

/**
 * Live monitor for one session: tails the main JSONL + each subagent file,
 * normalizes, reduces, and emits state diffs. This is the validated spike-0
 * pipeline (src/core) wrapped for the Electron main process.
 */
export class SessionMonitor {
  private readonly reducer = new StateReducer();
  private readonly readers = new Map<string, { reader: TailReader; agentId?: string }>();
  private readonly hookReader = new TailReader(HOOK_EVENTS_FILE, 0);
  private watchers: FSWatcher[] = [];
  private tickTimer?: NodeJS.Timeout;
  private session?: SessionInfo;

  constructor(private readonly onChanges: (changes: StateChange[]) => void) {}

  get currentSession(): SessionInfo | undefined {
    return this.session;
  }

  getSnapshot(): AgentState[] {
    return this.reducer.snapshot();
  }

  async start(projectFilter?: string): Promise<SessionInfo | undefined> {
    const session = await hottestSession(projectFilter);
    if (!session) return undefined;
    this.session = session;

    this.addReader(session.mainFile, undefined, true);

    const mainWatcher = chokidar.watch(session.mainFile, { usePolling: true, interval: 300, persistent: true });
    mainWatcher.on("change", () => void this.pump());

    const saWatcher = chokidar.watch(session.subagentsDir, {
      usePolling: true,
      interval: 300,
      persistent: true,
      ignoreInitial: false,
    });
    saWatcher.on("add", (file) => {
      const m = AGENT_FILE_RE.exec(path.basename(file));
      if (m) {
        this.addReader(file, m[1], false);
        void this.pump();
      }
    });
    saWatcher.on("change", () => void this.pump());

    // hooks channel — tail the events file if/when it exists (forward-ready;
    // no-op until the user installs the Agentville hook, see SPIKE-FINDINGS).
    const hookWatcher = chokidar.watch(HOOK_EVENTS_FILE, {
      usePolling: true,
      interval: 300,
      persistent: true,
      ignoreInitial: false,
    });
    hookWatcher.on("add", () => void this.pump());
    hookWatcher.on("change", () => void this.pump());

    this.watchers = [mainWatcher, saWatcher, hookWatcher];
    this.tickTimer = setInterval(() => this.emit(this.reducer.tick()), 3000);

    await this.pump();
    return session;
  }

  stop(): void {
    for (const w of this.watchers) void w.close();
    this.watchers = [];
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  private addReader(file: string, agentId: string | undefined, fromTail: boolean): void {
    if (this.readers.has(file)) return;
    this.readers.set(file, { reader: new TailReader(file, fromTail ? 64 * 1024 : 0), agentId });
  }

  private async pump(): Promise<void> {
    if (!this.session) return;
    const all: StateChange[] = [];
    // channel A — JSONL tail (main session + subagent files)
    for (const { reader, agentId } of this.readers.values()) {
      const lines = await reader.poll();
      for (const line of lines) {
        for (const r of normalizeLine(line, { sessionId: this.session.sessionId, fileAgentId: agentId })) {
          all.push(...this.reducer.apply(r));
        }
      }
    }
    // channel B — hooks events (authoritative lifecycle/permission/error)
    for (const line of await this.hookReader.poll()) {
      for (const r of normalizeHookLine(line, this.session.sessionId).records) {
        all.push(...this.reducer.apply(r));
      }
    }
    this.emit(all);
  }

  private emit(changes: StateChange[]): void {
    if (changes.length > 0) this.onChanges(changes);
  }
}
