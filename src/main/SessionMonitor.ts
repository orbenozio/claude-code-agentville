import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { normalizeHookLine, normalizeLine } from "../core/normalize.js";
import { StateReducer, type StateChange } from "../core/Reducer.js";
import { TailReader } from "../core/TailReader.js";
import type { AgentState } from "../core/types.js";
import { hottestSession, type SessionInfo } from "../spike/discovery.js";

const AGENT_FILE_RE = /agent-([a-z0-9]+)\.jsonl$/i;
// at startup, ignore subagent files that finished long ago — only resurrect
// recently-active ones, so the town isn't flooded with the whole session history.
const STALE_AGENT_MS = 180_000;
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
  private cwdPath?: string;

  constructor(private readonly onChanges: (changes: StateChange[]) => void) {}

  get currentSession(): SessionInfo | undefined {
    return this.session;
  }

  /** real working directory of the watched session (from the JSONL), if known */
  get cwd(): string | undefined {
    return this.cwdPath;
  }

  /** clean project name to show instead of the full encoded path */
  get projectName(): string | undefined {
    if (this.cwdPath) return path.basename(this.cwdPath);
    return this.session?.projectDir.split("-").filter(Boolean).pop();
  }

  private async readCwd(file: string): Promise<void> {
    try {
      const fh = await fs.open(file, "r");
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, 8192, 0);
      await fh.close();
      for (const line of buf.toString("utf8", 0, bytesRead).split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as { cwd?: string };
          if (o.cwd) {
            this.cwdPath = o.cwd;
            return;
          }
        } catch {
          /* partial/última line */
        }
      }
    } catch {
      /* ignore */
    }
  }

  getSnapshot(): AgentState[] {
    return this.reducer.snapshot();
  }

  async start(projectFilter?: string): Promise<SessionInfo | undefined> {
    const session = await hottestSession(projectFilter);
    if (!session) return undefined;
    this.session = session;
    await this.readCwd(session.mainFile);

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
      if (!m) return;
      void fs
        .stat(file)
        .then((st) => {
          if (Date.now() - st.mtimeMs > STALE_AGENT_MS) return; // finished long ago — skip
          this.addReader(file, m[1], false);
          void this.pump();
        })
        .catch(() => {});
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
