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
    win?.webContents.send("session-info", session ? { projectDir: session.projectDir, sessionId: session.sessionId } : null);
  });
}

ipcMain.handle("get-snapshot", () => monitor?.getSnapshot() ?? []);

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  monitor?.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
