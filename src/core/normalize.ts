import { z } from "zod";
import type { NormalizedRecord } from "./types.js";

/** Tool names that spawn a sub-agent. Flexible across CC versions (SPEC.md §9). */
export const SPAWN_TOOL_NAMES = new Set(["Agent", "Task"]);

/**
 * Rate-limit vs generic-error discriminator — applied ONLY inside a record already
 * flagged `isApiErrorMessage:true`. Matching these words against arbitrary content
 * produces massive false positives (a conversation that *discusses* rate limits trips
 * on every message), so we never scan free content text — only structured error records.
 */
const RATE_LIMIT_RE = /rate[ _]limit|usage limit/i;

/**
 * Boundary schema. Deliberately loose: every field optional, `.passthrough()`
 * so unknown future fields don't fail validation — the point is to *not crash*
 * on schema drift, while still rejecting non-objects.
 */
const RawLine = z
  .object({
    type: z.string().optional(),
    timestamp: z.string().optional(),
    sessionId: z.string().optional(),
    agentId: z.string().optional(),
    attributionAgent: z.string().optional(),
    isApiErrorMessage: z.boolean().optional(),
    message: z.unknown().optional(),
    toolUseResult: z.unknown().optional(),
  })
  .passthrough();

export interface NormalizeCtx {
  /** session id derived from the file path (fallback when absent in the line) */
  sessionId: string;
  /** if the line came from a subagents/agent-<id>.jsonl file, its agentId */
  fileAgentId?: string;
}

const INFRA_TYPES = new Set([
  "queue-operation",
  "ai-title",
  "mode",
  "attachment",
  "last-prompt",
  "file-history-snapshot",
  "system", // e.g. compact_boundary — infra, not an unknown schema
]);

function toMs(ts: string | undefined): number {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

/** Parse + validate + normalize one raw JSONL line. Never throws. */
export function normalizeLine(line: string, ctx: NormalizeCtx): NormalizedRecord[] {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return [{ kind: "unknown", source: "jsonl", ts: Date.now() }];
  }

  const parsed = RawLine.safeParse(json);
  if (!parsed.success) {
    return [{ kind: "unknown", source: "jsonl", ts: Date.now() }];
  }
  const r = parsed.data;
  const sessionId = r.sessionId ?? ctx.sessionId;
  const ts = toMs(r.timestamp);
  const agentId = ctx.fileAgentId ?? r.agentId; // subagent lines carry agentId

  if (r.type && INFRA_TYPES.has(r.type)) return [];

  const out: NormalizedRecord[] = [];
  const signal = signalFor(line, r);
  const type = r.attributionAgent; // subagent files carry the agent type here

  // --- assistant: look for tool_use blocks (spawn or open) ---
  if (r.type === "assistant") {
    for (const block of contentBlocks(r.message)) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const isSpawn =
          SPAWN_TOOL_NAMES.has(block.name) &&
          (input.subagent_type != null || input.description != null);
        if (isSpawn) {
          out.push({
            kind: "agent_spawn",
            source: "jsonl",
            toolUseId: block.id,
            sessionId,
            type: asString(input.subagent_type),
            task: asString(input.description),
            ts,
          });
        } else if (block.id) {
          out.push({ kind: "activity", source: "jsonl", sessionId, agentId, type, toolUseId: block.id, signal, ts });
        }
      }
    }
    if (out.length === 0) {
      out.push({ kind: "activity", source: "jsonl", sessionId, agentId, type, signal, ts });
    }
    return out;
  }

  // --- user: tool_result closes an open tool_use; toolUseResult may link an Agent ---
  if (r.type === "user") {
    const tr = r.toolUseResult as Record<string, unknown> | undefined;
    const blocks = contentBlocks(r.message);
    const resultBlock = blocks.find((b) => b.type === "tool_result");

    if (tr && typeof tr.agentId === "string") {
      // this is the result of an Agent spawn → links toolUseId ↔ agentId
      const toolUseId = resultBlock?.tool_use_id;
      if (toolUseId) {
        out.push({
          kind: "agent_linked",
          source: "jsonl",
          toolUseId,
          agentId: tr.agentId,
          sessionId,
          status: asString(tr.status),
          ts,
        });
      }
      if (tr.status === "completed") {
        out.push({ kind: "agent_done", source: "jsonl", agentId: tr.agentId, sessionId, ts });
      }
      return out;
    }

    if (resultBlock?.tool_use_id) {
      out.push({
        kind: "activity",
        source: "jsonl",
        sessionId,
        agentId,
        type,
        closesToolUseId: resultBlock.tool_use_id,
        signal,
        ts,
      });
      return out;
    }

    out.push({ kind: "activity", source: "jsonl", sessionId, agentId, type, signal, ts });
    return out;
  }

  return [{ kind: "unknown", source: "jsonl", ts }];
}

interface Block {
  type?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: unknown;
}

function contentBlocks(message: unknown): Block[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Block => !!b && typeof b === "object");
}

function signalFor(rawLine: string, r: z.infer<typeof RawLine>): "error" | "rateLimited" | undefined {
  // Only structured API-error records produce a signal — never free content text.
  if (r.isApiErrorMessage !== true) return undefined;
  return RATE_LIMIT_RE.test(rawLine) ? "rateLimited" : "error";
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// --- hooks channel (SPEC §6.3): compact events written by hooks/agentville-hook.mjs ---

const HookEvent = z
  .object({
    event: z.string().optional(),
    sessionId: z.string().optional(),
    agentId: z.string().optional(),
    type: z.string().optional(),
    notificationType: z.string().optional(),
    message: z.string().optional(),
    toolName: z.string().optional(),
    permissionRule: z.string().optional(),
    errorType: z.string().optional(),
    ts: z.string().optional(),
  })
  .passthrough();

export interface HookNormalizeResult {
  records: NormalizedRecord[];
  /** human-readable note for events the spike-0 reducer doesn't yet model (permission/idle) */
  info?: string;
}

/** Parse + normalize one compact hook-event line. Never throws. */
export function normalizeHookLine(line: string, fallbackSessionId = "hook"): HookNormalizeResult {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { records: [{ kind: "unknown", source: "hook", ts: Date.now() }] };
  }
  const parsed = HookEvent.safeParse(json);
  if (!parsed.success) return { records: [{ kind: "unknown", source: "hook", ts: Date.now() }] };
  const e = parsed.data;
  const sessionId = e.sessionId ?? fallbackSessionId;
  const ts = e.ts ? Date.parse(e.ts) || Date.now() : Date.now();

  switch (e.event) {
    case "SubagentStart":
      if (!e.agentId) return { records: [{ kind: "unknown", source: "hook", ts }] };
      return { records: [{ kind: "agent_spawn", source: "hook", agentId: e.agentId, sessionId, type: e.type, ts }] };
    case "SubagentStop":
      if (!e.agentId) return { records: [{ kind: "unknown", source: "hook", ts }] };
      return { records: [{ kind: "agent_done", source: "hook", agentId: e.agentId, sessionId, ts }] };
    case "Notification":
      return { records: [], info: `notification:${e.notificationType ?? "?"} — ${e.message ?? ""}` };
    case "PermissionRequest":
      return { records: [], info: `permission_request tool=${e.toolName ?? "?"} rule=${e.permissionRule ?? ""}` };
    case "StopFailure": {
      // authoritative error/rate-limit from the hook channel (SPIKE-FINDINGS) →
      // surface on the main agent (keyed by sessionId).
      const signal = e.errorType === "rate_limit" ? "rateLimited" : "error";
      return {
        records: [{ kind: "activity", source: "hook", sessionId, signal, ts }],
        info: `stop_failure:${e.errorType ?? "?"}`,
      };
    }
    default:
      return { records: [{ kind: "unknown", source: "hook", ts }] };
  }
}
