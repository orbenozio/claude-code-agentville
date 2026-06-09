import { test } from "node:test";
import assert from "node:assert/strict";
import { StateReducer, IDLE_THRESHOLD_MS, SUBAGENT_GONE_MS } from "../Reducer.js";

/** a controllable clock so time-based derivation is deterministic */
function fakeClock() {
  let now = 1_000_000;
  return { read: () => now, advance: (ms: number) => (now += ms), set: (v: number) => (now = v) };
}

function lastAfter(changes: { after: string }[]): string | undefined {
  return changes.length ? changes[changes.length - 1].after : undefined;
}

// ---------------------------------------------------------------------------
// JSONL spawn -> link -> working -> done (SPEC.md 5.3, 6.2)
// ---------------------------------------------------------------------------

test("JSONL subagent lifecycle: spawn(stash) -> linked(working) -> done", () => {
  const clk = fakeClock();
  const r = new StateReducer(clk.read);
  const ts = clk.read();

  // spawn via tool_use: stashed, no agentId yet -> no diff
  let ch = r.apply({ kind: "agent_spawn", source: "jsonl", toolUseId: "tu1", sessionId: "S1", type: "architect", task: "Draft spec", ts });
  assert.deepEqual(ch, [], "spawn without agentId should emit no diff (stashed)");

  // linked: agentId arrives -> first appearance emits a creation diff, state working
  ch = r.apply({ kind: "agent_linked", source: "jsonl", toolUseId: "tu1", agentId: "A1", sessionId: "S1", status: "in_progress", ts });
  assert.equal(ch.length, 1);
  assert.equal(ch[0].before, undefined, "first appearance diff has before:undefined");
  assert.equal(ch[0].after, "working");
  assert.equal(ch[0].state.task, "Draft spec", "task carried from the stashed spawn");
  assert.equal(ch[0].state.type, "architect");

  // done
  ch = r.apply({ kind: "agent_done", source: "jsonl", agentId: "A1", sessionId: "S1", ts });
  assert.equal(lastAfter(ch), "done");
});

test("first appearance of an already-working agent still emits a creation diff (Bug 3 regression)", () => {
  const clk = fakeClock();
  const r = new StateReducer(clk.read);
  // a subagent appears via its own activity file before any spawn linkage
  const ch = r.apply({ kind: "activity", source: "jsonl", sessionId: "S1", agentId: "A9", type: "reviewer", ts: clk.read() });
  assert.equal(ch.length, 1, "a brand-new agent whose initial derived state is working must still emit a diff");
  assert.equal(ch[0].before, undefined);
  assert.equal(ch[0].after, "working");
});

// ---------------------------------------------------------------------------
// idle threshold via tick (SPEC.md 6.2: working -> idle by IDLE_THRESHOLD only)
// ---------------------------------------------------------------------------

test("subagent goes working -> idle once silent past IDLE_THRESHOLD_MS", () => {
  const clk = fakeClock();
  const r = new StateReducer(clk.read);
  r.apply({ kind: "agent_spawn", source: "hook", agentId: "A1", sessionId: "S1", type: "x", ts: clk.read() });

  // just under threshold: still working
  clk.advance(IDLE_THRESHOLD_MS - 1);
  let ch = r.tick();
  assert.equal(lastAfter(ch), undefined, "no change just below threshold");

  // cross the threshold
  clk.advance(2);
  ch = r.tick();
  assert.equal(lastAfter(ch), "idle", "should transition to idle past IDLE_THRESHOLD_MS");
});

test("subagent silent past SUBAGENT_GONE_MS -> done (leaves town)", () => {
  const clk = fakeClock();
  const r = new StateReducer(clk.read);
  r.apply({ kind: "agent_spawn", source: "hook", agentId: "A1", sessionId: "S1", type: "x", ts: clk.read() });
  clk.advance(SUBAGENT_GONE_MS + 1);
  const ch = r.tick();
  assert.equal(lastAfter(ch), "done");
});

test("new activity resets the idle timer (working stays working)", () => {
  const clk = fakeClock();
  const r = new StateReducer(clk.read);
  r.apply({ kind: "activity", source: "jsonl", sessionId: "S1", agentId: "A1", ts: clk.read() });
  clk.advance(IDLE_THRESHOLD_MS - 100);
  // a fresh activity at the new 'now'
  r.apply({ kind: "activity", source: "jsonl", sessionId: "S1", agentId: "A1", ts: clk.read() });
  clk.advance(IDLE_THRESHOLD_MS - 100);
  const ch = r.tick();
  assert.equal(lastAfter(ch), undefined, "still within threshold after the reset -> no idle");
});

// ---------------------------------------------------------------------------
// open tool_use keeps "working" even when silent (SPEC.md 6.2)
// ---------------------------------------------------------------------------

test("an open tool_use overrides idle-by-silence", () => {
  const clk = fakeClock();
  const r = new StateReducer(clk.read);
  r.apply({ kind: "activity", source: "jsonl", sessionId: "S1", agentId: "A1", toolUseId: "open1", ts: clk.read() });
  clk.advance(IDLE_THRESHOLD_MS + 10_000); // long silence, but tool still open
  let ch = r.tick();
  assert.equal(lastAfter(ch), undefined, "open tool_use -> stays working, no idle diff");

  // close it, then silence -> idle
  r.apply({ kind: "activity", source: "jsonl", sessionId: "S1", agentId: "A1", closesToolUseId: "open1", ts: clk.read() });
  clk.advance(IDLE_THRESHOLD_MS + 1);
  ch = r.tick();
  assert.equal(lastAfter(ch), "idle");
});

// ---------------------------------------------------------------------------
// sticky error / rateLimited (SPEC.md 6.2: sticky until a clean record clears it)
// ---------------------------------------------------------------------------

test("error signal is sticky and survives a tick, then clears on a clean record", () => {
  const clk = fakeClock();
  const r = new StateReducer(clk.read);
  r.apply({ kind: "activity", source: "jsonl", sessionId: "S1", agentId: "A1", ts: clk.read() });

  let ch = r.apply({ kind: "activity", source: "jsonl", sessionId: "S1", agentId: "A1", signal: "error", ts: clk.read() });
  assert.equal(lastAfter(ch), "error");

  // a tick does not clear it
  ch = r.tick();
  assert.equal(lastAfter(ch), undefined, "error sticks across a tick");

  // a clean activity record (no signal) clears it -> back to working
  ch = r.apply({ kind: "activity", source: "jsonl", sessionId: "S1", agentId: "A1", ts: clk.read() });
  assert.equal(lastAfter(ch), "working", "a clean record clears the sticky error");
});

test("rateLimited takes priority over working in the same window", () => {
  const clk = fakeClock();
  const r = new StateReducer(clk.read);
  r.apply({ kind: "activity", source: "jsonl", sessionId: "S1", agentId: "A1", ts: clk.read() });
  const ch = r.apply({ kind: "activity", source: "jsonl", sessionId: "S1", agentId: "A1", signal: "rateLimited", toolUseId: "open", ts: clk.read() });
  assert.equal(lastAfter(ch), "rateLimited", "sticky signal wins even with an open tool_use");
});

// ---------------------------------------------------------------------------
// main agent has no "done" (SPEC.md 6.2)
// ---------------------------------------------------------------------------

test("main agent (agentId === sessionId) toggles working<->idle, never done", () => {
  const clk = fakeClock();
  const r = new StateReducer(clk.read);
  // activity with no agentId => main, keyed by sessionId
  let ch = r.apply({ kind: "activity", source: "jsonl", sessionId: "S1", ts: clk.read() });
  assert.equal(ch[0].state.kind, "main");
  assert.equal(ch[0].after, "working");

  clk.advance(SUBAGENT_GONE_MS + 100_000); // far past even the subagent-gone window
  ch = r.tick();
  assert.equal(lastAfter(ch), "idle", "main agent goes idle, NOT done, after long silence");
});

// ---------------------------------------------------------------------------
// idempotency: re-applying agent_done does not re-emit (SPEC.md 8)
// ---------------------------------------------------------------------------

test("re-applying agent_done is idempotent (no duplicate done diff)", () => {
  const clk = fakeClock();
  const r = new StateReducer(clk.read);
  r.apply({ kind: "agent_spawn", source: "hook", agentId: "A1", sessionId: "S1", ts: clk.read() });
  const first = r.apply({ kind: "agent_done", source: "hook", agentId: "A1", sessionId: "S1", ts: clk.read() });
  assert.equal(lastAfter(first), "done");
  const second = r.apply({ kind: "agent_done", source: "hook", agentId: "A1", sessionId: "S1", ts: clk.read() });
  assert.deepEqual(second, [], "second done must not emit a diff");
});
