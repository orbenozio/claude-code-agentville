// Minimal esbuild pipeline for the Electron app.
//  - main.cjs / preload.cjs : node platform, node_modules left external (Electron resolves them)
//  - renderer.js            : browser ESM bundle (Pixi bundled in)
//  - index.html             : copied to dist
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const out = path.join(root, "dist");
await mkdir(out, { recursive: true });

const nodeCommon = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  packages: "external", // resolve chokidar/zod/electron from node_modules at runtime
  sourcemap: true,
  logLevel: "info",
};

await Promise.all([
  build({ ...nodeCommon, entryPoints: [path.join(root, "src/main/main.ts")], outfile: path.join(out, "main.cjs") }),
  build({ ...nodeCommon, entryPoints: [path.join(root, "src/main/preload.ts")], outfile: path.join(out, "preload.cjs") }),
  build({
    entryPoints: [path.join(root, "src/renderer/renderer.ts")],
    outfile: path.join(out, "renderer.js"),
    bundle: true,
    platform: "browser",
    target: "chrome120",
    format: "esm",
    sourcemap: true,
    logLevel: "info",
  }),
]);

await cp(path.join(root, "src/renderer/index.html"), path.join(out, "index.html"));
console.log("build complete → dist/");
