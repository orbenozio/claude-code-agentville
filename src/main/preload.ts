import { contextBridge, ipcRenderer } from "electron";
import type { AgentState } from "../core/types.js";
import type { StateChange } from "../core/Reducer.js";

export interface SessionInfo {
  projectDir: string;
  sessionId: string;
}

export interface AgentvilleApi {
  onAgentDiff(cb: (changes: StateChange[]) => void): void;
  onSessionInfo(cb: (info: SessionInfo | null) => void): void;
  getSnapshot(): Promise<AgentState[]>;
}

const api: AgentvilleApi = {
  onAgentDiff: (cb) => ipcRenderer.on("agent-diff", (_e, changes) => cb(changes)),
  onSessionInfo: (cb) => ipcRenderer.on("session-info", (_e, info) => cb(info)),
  getSnapshot: () => ipcRenderer.invoke("get-snapshot"),
};

contextBridge.exposeInMainWorld("agentville", api);
