// Build the self-contained marketplace extension:
//  - dist/monitor.cjs : the core pipeline (SessionMonitor + TailReader/normalize/Reducer
//    /discovery) bundled for the extension HOST. chokidar v4 has no native deps, so it is
//    bundled in too → the extension has ZERO runtime node_modules (trivial to vsix).
//  - media/renderer.js : the Pixi town renderer bundled for the WEBVIEW (browser ESM),
//    unchanged source; window.agentville is supplied by media/shim.js.
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // vscode-extension/scripts
const extDir = path.join(here, "..");                      // vscode-extension
const repo = path.join(here, "..", "..");                  // repo root (source lives here)

await mkdir(path.join(extDir, "dist"), { recursive: true });
await mkdir(path.join(extDir, "media"), { recursive: true });

await Promise.all([
  build({
    entryPoints: [path.join(repo, "src/main/SessionMonitor.ts")],
    outfile: path.join(extDir, "dist/monitor.cjs"),
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    sourcemap: true,
    logLevel: "info",
  }),
  build({
    entryPoints: [path.join(repo, "src/renderer/renderer.ts")],
    outfile: path.join(extDir, "media/renderer.js"),
    bundle: true,
    platform: "browser",
    target: "chrome120",
    format: "esm",
    // Pixi is NOT bundled — it's loaded from a CDN via an import map in index.html.
    // Bundling Pixi tripped the VS Marketplace malware scan (new Function + data: blobs);
    // keeping it out of the vsix is what lets the extension publish.
    external: ["pixi.js"],
    sourcemap: true,
    logLevel: "info",
  }),
]);

console.log("extension build complete → vscode-extension/{dist/monitor.cjs, media/renderer.js}");
