// Core domain types shared across the spike (and, later, the full app).
// These mirror SPEC.md §6.1 but trimmed to what the spike actually needs.

export type AgentKind = "main" | "subagent";

export type AgentVisualState =
  | "idle" // 🏠
  | "working" // 🏭
  | "done" // ✅ (subagent only)
  | "error" // ⚠️
  | "rateLimited"; // 😴
// note: "awaitingApproval" (⏳) is deferred to the hooks channel — not derived in spike-0.

/**
 * A raw JSONL line (or hook event) normalized into a stable internal shape.
 * The rest of the system never touches raw Claude Code field names — only this.
 */
export type NormalizedRecord =
  | {
      kind: "agent_spawn";
      source: "jsonl" | "hook";
      /** present immediately from hooks; from JSONL only after agent_linked */
      agentId?: string;
      /** JSONL fallback linkage key (the spawning tool_use id) */
      toolUseId?: string;
      sessionId: string;
      type?: string; // subagent_type
      task?: string; // description → speech bubble
      ts: number;
    }
  | {
      kind: "agent_linked";
      source: "jsonl";
      toolUseId: string;
      agentId: string;
      sessionId: string;
      status?: string;
      ts: number;
    }
  | {
      kind: "agent_done";
      source: "jsonl" | "hook";
      agentId: string;
      sessionId: string;
      ts: number;
    }
  | {
      kind: "activity";
      source: "jsonl" | "hook";
      sessionId: string;
      /** agentId if this came from a subagent file; undefined = main session */
      agentId?: string;
      /** type hint from the subagent file's `attributionAgent` (SPEC §6.1 fallback) */
      type?: string;
      /** open/close tracking for "working" derivation */
      toolUseId?: string;
      closesToolUseId?: string;
      signal?: "error" | "rateLimited";
      ts: number;
    }
  | {
      kind: "unknown";
      source: "jsonl" | "hook";
      ts: number;
    };

export interface AgentState {
  agentId: string; // for main: equals sessionId
  sessionId: string;
  kind: AgentKind;
  type?: string;
  task?: string;
  state: AgentVisualState;
  lastActivityTs: number;
  spawnTs: number;
  doneTs?: number;
}
