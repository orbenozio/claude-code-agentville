// Launch the built Electron app.
// Critically clears ELECTRON_RUN_AS_NODE — VSCode's integrated terminal (and other
// Electron-host shells) export it, which would force electron.exe to run as plain
// Node and make require('electron') return a path string instead of the API.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const require = createRequire(import.meta.url);
const electronExe = require("electron"); // path string to the electron binary

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronExe, [path.join(root, "dist", "main.cjs")], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
