import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { SessionMonitor } from "./SessionMonitor.js";

// esbuild emits this bundle as CJS, so __dirname resolves to dist/ at runtime.
declare const __dirname: string;
const here = __dirname;

let win: BrowserWindow | null = null;
let monitor: SessionMonitor | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: "Agentville 🏘️",
    backgroundColor: "#7ec850",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses require('electron'); core runs in main, not here
    },
  });

  win.removeMenu();
  void win.loadFile(path.join(here, "index.html"));

  monitor = new SessionMonitor((changes) => {
    win?.webContents.send("agent-diff", changes);
  });

  // start monitoring once the renderer is ready to receive
  win.webContents.once("did-finish-load", async () => {
    const session = await monitor!.start();
    win?.webContents.send("session-info", session ? { projectName: monitor!.projectName ?? "project", sessionId: session.sessionId } : null);
  });
}

ipcMain.handle("get-snapshot", () => monitor?.getSnapshot() ?? []);

// weather via the main process (no CORS issues) — Open-Meteo, keyless
ipcMain.handle("get-weather", async (_e, city: string) => {
  try {
    const geo = (await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`,
    ).then((r) => r.json())) as { results?: { name: string; latitude: number; longitude: number }[] };
    if (!geo.results?.length) return { error: "not_found" as const };
    const g = geo.results[0];
    const wx = (await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current=weather_code,temperature_2m`,
    ).then((r) => r.json())) as { current?: { weather_code: number; temperature_2m: number } };
    const code = wx.current?.weather_code ?? 0;
    const temp = Math.round(wx.current?.temperature_2m ?? 0);
    console.log(`[weather] ${g.name}: code=${code} temp=${temp}°C`);
    return { name: g.name, code, temp };
  } catch (e) {
    console.log("[weather] fetch failed:", (e as Error).message);
    return { error: "fetch_failed" as const };
  }
});

// Single instance: when the launcher button is clicked while the app is already
// open, focus the existing window instead of spawning a second town.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(createWindow);
}

app.on("window-all-closed", () => {
  monitor?.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
