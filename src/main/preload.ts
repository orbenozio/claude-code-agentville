import { contextBridge, ipcRenderer } from "electron";
import type { AgentState } from "../core/types.js";
import type { StateChange } from "../core/Reducer.js";

export interface SessionInfo {
  projectName: string;
  sessionId: string;
}

export type WeatherResult = { name: string; code: number; temp: number } | { error: "not_found" | "fetch_failed" };

export interface AgentvilleApi {
  onAgentDiff(cb: (changes: StateChange[]) => void): void;
  onSessionInfo(cb: (info: SessionInfo | null) => void): void;
  getSnapshot(): Promise<AgentState[]>;
  getWeather(city: string): Promise<WeatherResult>;
}

const api: AgentvilleApi = {
  onAgentDiff: (cb) => ipcRenderer.on("agent-diff", (_e, changes) => cb(changes)),
  onSessionInfo: (cb) => ipcRenderer.on("session-info", (_e, info) => cb(info)),
  getSnapshot: () => ipcRenderer.invoke("get-snapshot"),
  getWeather: (city) => ipcRenderer.invoke("get-weather", city),
};

contextBridge.exposeInMainWorld("agentville", api);
