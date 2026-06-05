import type { AgentState, AgentVisualState, NormalizedRecord } from "./types.js";

export const IDLE_THRESHOLD_MS = 45_000; // SPEC.md ש1

export interface StateChange {
  agentId: string;
  before?: AgentVisualState;
  after: AgentVisualState;
  state: AgentState;
}

/**
 * Minimal state derivation (SPEC.md §6.2), hooks-less / spike-0 subset:
 *   working / idle / done / error / rateLimited.
 * Keyed by agentId; the main agent uses agentId === sessionId.
 */
export class StateReducer {
  /**
   * Clock used for time-based derivation (idle vs working). In live mode this is
   * the wall clock — crucial, because a freshly-opened file delivers a *backlog*
   * of old records whose own timestamps would otherwise read as "just active".
   * Replay injects a simulated monotonic clock for determinism.
   */
  constructor(private readonly clock: () => number = () => Date.now()) {}

  private readonly agents = new Map<string, AgentState>();
  /** agentIds whose first appearance has already been emitted as a diff */
  private readonly announced = new Set<string>();
  /** agentIds whose metadata (type/task) changed and needs a refresh diff */
  private readonly dirty = new Set<string>();
  /** toolUseId → agentId, for the JSONL spawn→link race window */
  private readonly pendingSpawns = new Map<string, { type?: string; task?: string; ts: number }>();
  /** open tool_use ids per agent (for "working" derivation) */
  private readonly openToolUses = new Map<string, Set<string>>();
  /** last error/rate-limit signal time per agent */
  private readonly stickySignal = new Map<string, { kind: "error" | "rateLimited"; ts: number }>();

  apply(rec: NormalizedRecord): StateChange[] {
    switch (rec.kind) {
      case "agent_spawn": {
        if (rec.agentId) {
          // hook path: agentId known immediately
          this.upsert(rec.agentId, rec.sessionId, "subagent", { type: rec.type, task: rec.task, spawnTs: rec.ts });
          return this.recompute(rec.agentId, this.clock());
        }
        if (rec.toolUseId) {
          // jsonl path: stash until agent_linked supplies the agentId
          this.pendingSpawns.set(rec.toolUseId, { type: rec.type, task: rec.task, ts: rec.ts });
        }
        return [];
      }

      case "agent_linked": {
        const pending = this.pendingSpawns.get(rec.toolUseId);
        this.pendingSpawns.delete(rec.toolUseId);
        this.upsert(rec.agentId, rec.sessionId, "subagent", {
          type: pending?.type,
          task: pending?.task,
          spawnTs: pending?.ts ?? rec.ts,
        });
        return this.recompute(rec.agentId, this.clock());
      }

      case "agent_done": {
        const a = this.agents.get(rec.agentId);
        if (!a) return [];
        const before = this.announced.has(a.agentId) ? a.state : undefined;
        this.announced.add(a.agentId);
        a.state = "done";
        a.doneTs = rec.ts;
        a.lastActivityTs = rec.ts;
        return before === "done" ? [] : [{ agentId: a.agentId, before, after: "done", state: { ...a } }];
      }

      case "activity": {
        const id = rec.agentId ?? rec.sessionId; // main agent keyed by sessionId
        const kind = rec.agentId ? "subagent" : "main";
        // a subagent appears via its own file BEFORE the spawning Agent's result
        // links the id. Claim the pending spawn's task now so the working agent
        // can show its task bubble immediately (don't wait for completion).
        let task: string | undefined;
        let type = rec.type;
        if (kind === "subagent" && !this.agents.has(id)) {
          const claimed = this.claimSpawn(rec.type);
          if (claimed) {
            task = claimed.task;
            type = type ?? claimed.type;
          }
        }
        this.upsert(id, rec.sessionId, kind, { type, task, spawnTs: rec.ts });

        if (rec.toolUseId) this.openSet(id).add(rec.toolUseId);
        if (rec.closesToolUseId) this.openSet(id).delete(rec.closesToolUseId);

        if (rec.signal) this.stickySignal.set(id, { kind: rec.signal, ts: rec.ts });
        else this.clearStaleSignal(id);

        const a = this.agents.get(id)!;
        a.lastActivityTs = rec.ts;
        return this.recompute(id, this.clock());
      }

      default:
        return [];
    }
  }

  /** Time-driven tick: promotes silent agents to idle. */
  tick(now = this.clock()): StateChange[] {
    const changes: StateChange[] = [];
    for (const id of this.agents.keys()) changes.push(...this.recompute(id, now));
    return changes;
  }

  snapshot(): AgentState[] {
    return [...this.agents.values()].map((a) => ({ ...a }));
  }

  // --- internals ---

  private recompute(id: string, now: number): StateChange[] {
    const a = this.agents.get(id);
    if (!a) return [];
    // every agent's first appearance emits a creation diff, even if its derived
    // state equals its initial state — otherwise a diff-based renderer never sees it.
    if (!this.announced.has(id)) {
      this.announced.add(id);
      this.dirty.delete(id);
      a.state = a.state === "done" ? "done" : this.deriveState(a, now);
      return [{ agentId: id, before: undefined, after: a.state, state: { ...a } }];
    }
    if (a.state !== "done") {
      const before = a.state;
      const after = this.deriveState(a, now);
      if (after !== before) {
        a.state = after;
        this.dirty.delete(id);
        return [{ agentId: id, before, after, state: { ...a } }];
      }
    }
    // no visual-state change, but type/task arrived later → push a refresh diff
    if (this.dirty.has(id)) {
      this.dirty.delete(id);
      return [{ agentId: id, before: a.state, after: a.state, state: { ...a } }];
    }
    return [];
  }

  private deriveState(a: AgentState, now: number): AgentVisualState {
    // error/rateLimited are sticky until a clean record clears them (SPEC §6.2).
    const sig = this.stickySignal.get(a.agentId);
    if (sig) return sig.kind;
    // an open tool_use means the agent is busy even if the file is momentarily
    // silent — don't let a long-running tool be misread as idle.
    if ((this.openToolUses.get(a.agentId)?.size ?? 0) > 0) return "working";
    if (now - a.lastActivityTs > IDLE_THRESHOLD_MS) return "idle";
    return "working";
  }

  /** A clean record (assistant/tool_use without an error signal) clears a sticky signal. */
  private clearStaleSignal(id: string): void {
    this.stickySignal.delete(id);
  }

  private upsert(
    agentId: string,
    sessionId: string,
    kind: "main" | "subagent",
    fields: { type?: string; task?: string; spawnTs: number },
  ): void {
    const existing = this.agents.get(agentId);
    if (existing) {
      if (fields.type && !existing.type) {
        existing.type = fields.type;
        this.dirty.add(agentId);
      }
      if (fields.task && !existing.task) {
        existing.task = fields.task;
        this.dirty.add(agentId);
      }
      return;
    }
    this.agents.set(agentId, {
      agentId,
      sessionId,
      kind,
      type: fields.type,
      task: fields.task,
      state: "working",
      lastActivityTs: fields.spawnTs,
      spawnTs: fields.spawnTs,
    });
  }

  /** Claim a pending JSONL spawn for a newly-appeared subagent — prefer a
   *  matching subagent_type, else the oldest unclaimed one (FIFO). */
  private claimSpawn(type?: string): { task?: string; type?: string } | undefined {
    let oldestKey: string | undefined;
    let oldestTs = Infinity;
    for (const [k, v] of this.pendingSpawns) {
      if (type && v.type === type) {
        this.pendingSpawns.delete(k);
        return { task: v.task, type: v.type };
      }
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (!oldestKey) return undefined;
    const v = this.pendingSpawns.get(oldestKey)!;
    this.pendingSpawns.delete(oldestKey);
    return { task: v.task, type: v.type };
  }

  private openSet(id: string): Set<string> {
    let s = this.openToolUses.get(id);
    if (!s) {
      s = new Set();
      this.openToolUses.set(id, s);
    }
    return s;
  }
}
