import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLine, normalizeHookLine } from "../normalize.js";
import type { NormalizedRecord } from "../types.js";

const ctx = { sessionId: "S1" };

/** pull the first activity record (the one that carries the error/rateLimited signal) */
function activity(recs: NormalizedRecord[]): Extract<NormalizedRecord, { kind: "activity" }> | undefined {
  return recs.find((r): r is Extract<NormalizedRecord, { kind: "activity" }> => r.kind === "activity");
}

// ---------------------------------------------------------------------------
// SPIKE-FINDINGS "Bug 1" regression: error/rateLimited must come ONLY from the
// structured isApiErrorMessage:true field, never from free content text.
// SPEC.md 6.2 (error/rateLimited rows).
// ---------------------------------------------------------------------------

test("free content text 'rate limit' WITHOUT isApiErrorMessage produces NO signal (Bug 1 regression)", () => {
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-09T10:00:00Z",
    message: {
      content: [
        { type: "text", text: "Let's discuss how to handle the rate limit and overloaded errors in our retry logic" },
      ],
    },
  });
  const recs = normalizeLine(line, ctx);
  const a = activity(recs);
  assert.ok(a, "expected an activity record");
  assert.equal(a!.signal, undefined, "content text mentioning 'rate limit' must NOT set a signal");
});

test("free content text 'overloaded'/'error' WITHOUT isApiErrorMessage produces NO signal", () => {
  const line = JSON.stringify({
    type: "user",
    timestamp: "2026-06-09T10:00:00Z",
    message: { content: [{ type: "text", text: "I got an error: the server is overloaded" }] },
  });
  const a = activity(normalizeLine(line, ctx));
  assert.ok(a);
  assert.equal(a!.signal, undefined);
});

test("structured error record (isApiErrorMessage:true) WITHOUT rate-limit text -> 'error'", () => {
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-09T10:00:00Z",
    isApiErrorMessage: true,
    message: { content: [{ type: "text", text: "Internal server error (500)" }] },
  });
  const a = activity(normalizeLine(line, ctx));
  assert.ok(a);
  assert.equal(a!.signal, "error");
});

test("structured error record WITH 'rate limit' text -> 'rateLimited'", () => {
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-09T10:00:00Z",
    isApiErrorMessage: true,
    message: { content: [{ type: "text", text: "API Error: rate limit exceeded, retry later" }] },
  });
  const a = activity(normalizeLine(line, ctx));
  assert.ok(a);
  assert.equal(a!.signal, "rateLimited");
});

test("structured error record WITH 'usage limit' text -> 'rateLimited'", () => {
  const line = JSON.stringify({
    type: "user",
    timestamp: "2026-06-09T10:00:00Z",
    isApiErrorMessage: true,
    message: { content: [{ type: "text", text: "You have reached your usage limit for this period" }] },
  });
  const a = activity(normalizeLine(line, ctx));
  assert.ok(a);
  assert.equal(a!.signal, "rateLimited");
});

test("isApiErrorMessage:false is treated as no signal even with rate-limit text", () => {
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-09T10:00:00Z",
    isApiErrorMessage: false,
    message: { content: [{ type: "text", text: "rate limit" }] },
  });
  const a = activity(normalizeLine(line, ctx));
  assert.ok(a);
  assert.equal(a!.signal, undefined);
});

// ---------------------------------------------------------------------------
// hooks channel: StopFailure -> authoritative signal (SPIKE-FINDINGS, normalize.ts)
// ---------------------------------------------------------------------------

test("hook StopFailure errorType=rate_limit -> rateLimited signal", () => {
  const { records } = normalizeHookLine(JSON.stringify({ event: "StopFailure", sessionId: "S1", errorType: "rate_limit" }));
  const a = activity(records);
  assert.ok(a);
  assert.equal(a!.signal, "rateLimited");
});

test("hook StopFailure errorType=overloaded -> error signal", () => {
  const { records } = normalizeHookLine(JSON.stringify({ event: "StopFailure", sessionId: "S1", errorType: "overloaded" }));
  const a = activity(records);
  assert.ok(a);
  assert.equal(a!.signal, "error");
});

// ---------------------------------------------------------------------------
// schema-forgiveness / never-throw boundary (SPEC.md 9)
// ---------------------------------------------------------------------------

test("invalid JSON -> single unknown record, never throws", () => {
  const recs = normalizeLine("{not json", ctx);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, "unknown");
});

test("infra-noise types are dropped (empty output)", () => {
  for (const t of ["queue-operation", "ai-title", "mode", "attachment", "last-prompt", "file-history-snapshot", "system"]) {
    const recs = normalizeLine(JSON.stringify({ type: t, timestamp: "2026-06-09T10:00:00Z" }), ctx);
    assert.deepEqual(recs, [], `type=${t} should be dropped`);
  }
});

test("Agent tool_use with description -> agent_spawn carrying task/type", () => {
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-09T10:00:00Z",
    message: {
      content: [
        { type: "tool_use", id: "tu1", name: "Agent", input: { subagent_type: "architect", description: "Draft spec" } },
      ],
    },
  });
  const recs = normalizeLine(line, ctx);
  const spawn = recs.find((r) => r.kind === "agent_spawn") as Extract<NormalizedRecord, { kind: "agent_spawn" }>;
  assert.ok(spawn, "expected agent_spawn");
  assert.equal(spawn.type, "architect");
  assert.equal(spawn.task, "Draft spec");
  assert.equal(spawn.toolUseId, "tu1");
});

test("legacy 'Task' tool name also spawns (schema forgiveness, SPEC.md 9)", () => {
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-09T10:00:00Z",
    message: { content: [{ type: "tool_use", id: "tu2", name: "Task", input: { subagent_type: "reviewer", description: "Review" } }] },
  });
  const recs = normalizeLine(line, ctx);
  assert.ok(recs.some((r) => r.kind === "agent_spawn"));
});
