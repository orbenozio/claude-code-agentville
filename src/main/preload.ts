import { contextBridge, ipcRenderer } from "electron";
import type { AgentState } from "../core/types.js";
import type { StateChange } from "../core/Reducer.js";

export interface SessionInfo {
  projectName: string;
  sessionId: string;
}

export type WeatherResult = { name: string; code: number; temp: number } | { error: "not_found" | "fetch_failed" };

// Mirror the full surface the shared renderer expects (see vscode-extension/media/shim.js).
// onNeighbors/switchSession/setMaxVillages are multi-village features that only the VSCode
// host drives; standalone has a single village, so they are present but inert here. They
// must still EXIST, or the renderer throws on first call and the entrance never arms.
export interface AgentvilleApi {
  onAgentDiff(cb: (changes: StateChange[]) => void): void;
  onSessionInfo(cb: (info: SessionInfo | null) => void): void;
  onNeighbors(cb: (neighbors: unknown[]) => void): void;
  onVisibility(cb: (visible: boolean) => void): void;
  getSnapshot(): Promise<AgentState[]>;
  getWeather(city: string): Promise<WeatherResult>;
  switchSession(sessionId: string): Promise<void>;
  setMaxVillages(n: number): Promise<void>;
}

const api: AgentvilleApi = {
  onAgentDiff: (cb) => ipcRenderer.on("agent-diff", (_e, changes) => cb(changes)),
  onSessionInfo: (cb) => ipcRenderer.on("session-info", (_e, info) => cb(info)),
  onNeighbors: (cb) => ipcRenderer.on("neighbors", (_e, neighbors) => cb(neighbors)),
  onVisibility: (cb) => ipcRenderer.on("visibility", (_e, visible) => cb(visible)),
  getSnapshot: () => ipcRenderer.invoke("get-snapshot"),
  getWeather: (city) => ipcRenderer.invoke("get-weather", city),
  switchSession: (sessionId) => ipcRenderer.invoke("switch-session", sessionId),
  setMaxVillages: (n) => ipcRenderer.invoke("set-max-villages", n),
};

contextBridge.exposeInMainWorld("agentville", api);
