import { Application, Container, Graphics, Text } from "pixi.js";
import type { AgentState, AgentVisualState } from "../core/types.js";
import type { StateChange } from "../core/Reducer.js";

// ---- bridge typing (exposed by preload) ----
interface SessionInfo {
  projectName: string;
  sessionId: string;
}
type WeatherResult = { name: string; code: number; temp: number } | { error: "not_found" | "fetch_failed" };
interface AgentvilleApi {
  onAgentDiff(cb: (changes: StateChange[]) => void): void;
  onSessionInfo(cb: (info: SessionInfo | null) => void): void;
  getSnapshot(): Promise<AgentState[]>;
  getWeather(city: string): Promise<WeatherResult>;
}
declare global {
  interface Window {
    agentville: AgentvilleApi;
  }
}

const STATE_BADGE: Record<AgentVisualState, string> = {
  idle: "",
  working: "",
  done: "✅",
  error: "⚠️",
  rateLimited: "😴",
};

// agent colors — deliberately NO greens (grass is green); bright & mutually distinct
const PALETTE = [
  0xe63946, 0x3a86ff, 0xff8c42, 0x9b5de5, 0xff70a6, 0x00b4d8, 0xf4a259, 0x8338ec, 0xef476f, 0x118ab2,
  0xd62828, 0x5e60ce, 0xff6b6b, 0x4361ee, 0xc77dff,
];
const MAYOR_COLOR = 0xffd23f;
const HARDHAT_COLOR = 0xff7b00;

const hud = document.getElementById("hud")!;

// local time of day drives sky/ambient/lamps; an optional override lets you preview any time
type TimeMode = "auto" | "dawn" | "day" | "dusk" | "night";
let timeOverride: TimeMode = "auto";
function localHour(): number {
  switch (timeOverride) {
    case "dawn":
      return 6;
    case "day":
      return 13;
    case "dusk":
      return 19;
    case "night":
      return 23;
    default:
      return new Date().getHours() + new Date().getMinutes() / 60;
  }
}

let townName = localStorage.getItem("agentville.town") || "Agentville";
let projectName = "";
function updateHud() {
  hud.textContent = projectName ? `🏘️ ${townName}  ·  watching ${projectName}` : `🏘️ ${townName}`;
}

const app = new Application();
await app.init({ resizeTo: window, background: 0x7ec850, antialias: true });
document.getElementById("app")!.appendChild(app.canvas);


// ---------------------------------------------------------------- layout
// the town square sits in the CENTRE; houses ring it; the mayor's hall is at its head (top).
interface Layout {
  skyH: number;
  riverY: number;
  sq: { cx: number; cy: number; rx: number; ry: number }; // central square ellipse
  mayor: { x: number; y: number }; // town hall, at the head (top) of the square
  ringRx: number; // radius of the house ring around the square
  ringRy: number;
  workFloor: { x: number; y: number; w: number; h: number }; // where agents mill while working
}
function computeLayout(): Layout {
  const W = app.screen.width;
  const H = app.screen.height;
  const skyH = 100;
  const riverY = 140;
  const cx = W / 2;
  const topUsable = riverY + 86;
  const cy = (topUsable + H) / 2 + 4;
  const rx = Math.max(190, Math.min(W * 0.27, 340)); // big, scales with width
  const ry = rx * 0.6;
  return {
    skyH,
    riverY,
    sq: { cx, cy, rx, ry },
    mayor: { x: cx, y: cy - ry - 50 },
    ringRx: rx + 78,
    ringRy: ry + 66,
    workFloor: { x: cx - rx * 0.55, y: cy + ry * 0.18, w: rx * 1.1, h: ry * 0.55 },
  };
}
let L = computeLayout();

// ---------------------------------------------------------------- layers (back → front)
// ground plane (grass, road, paths) → ground animals (pass BEHIND buildings) →
// structures (factory/trees/house-walls) → agents → roofs → sky (birds, above all)
const bgStatic = new Container(); // sky + grass + river + flowers + road
const cloudLayer = new Container(); // drifting clouds
const fishLayer = new Container(); // jumping fish (over the river)
const pathLayer = new Container(); // per-house paths (painted on the ground)
const groundAnimalLayer = new Container(); // sheep, cows, horses, chickens
const structStatic = new Container(); // factory + fruit trees
const houseWallLayer = new Container(); // per-house walls
const agentLayer = new Container(); // characters
const roofLayer = new Container(); // house roofs (in front → agent looks "inside")
const skyLayer = new Container(); // birds
// scene fills the real window edge-to-edge; layout reflows on resize
app.stage.addChild(bgStatic, cloudLayer, fishLayer, pathLayer, groundAnimalLayer, structStatic, houseWallLayer, agentLayer, roofLayer, skyLayer);

// ---------------------------------------------------------------- weather (Open-Meteo, keyless)
const weatherLayer = new Container(); // foreground: ambient tint + lights + dim overlay + rain/snow
const ambientTint = new Graphics(); // time-of-day tint over the whole village
const streetLights = new Graphics(); // lamp glow — above the tint so it brightens the night
streetLights.blendMode = "add";
const weatherOverlay = new Graphics(); // weather dimming over the whole village
const weatherFx = new Graphics(); // rain/snow particles
weatherLayer.addChild(ambientTint, streetLights, weatherOverlay, weatherFx);
app.stage.addChild(weatherLayer);

// tint the whole scene by local time of day (so the VILLAGE reflects it, not just the sky)
function updateAmbient() {
  const W = app.screen.width;
  const H = app.screen.height;
  const h = localHour();
  let color = 0x000000;
  let alpha = 0;
  if (h < 5.5 || h >= 20) {
    color = 0x0a1430;
    alpha = 0.42;
  } // night
  else if (h < 7) {
    color = 0xff8a4d;
    alpha = 0.16;
  } // dawn
  else if (h >= 18.5) {
    color = 0xff6a3c;
    alpha = 0.2;
  } // dusk
  ambientTint.clear();
  if (alpha > 0) ambientTint.rect(0, 0, W, H).fill(color, alpha);
}

// six lampposts around the square; their head sits ~46px above the base point
function lampPositions(): { x: number; y: number }[] {
  const { cx, cy, rx, ry } = L.sq;
  // offset 0 → lamps sit at the sides, leaving clear gaps at the top (town hall)
  // and bottom (welcome sign) so none overlaps them
  const pts: { x: number; y: number }[] = [];
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * (rx + 32), y: cy + Math.sin(a) * (ry + 26) });
  }
  return pts;
}

// street lamps + the welcome sign light up from dusk through dawn (local time)
function updateLights() {
  streetLights.clear();
  const h = localHour();
  const on = h < 6.2 || h >= 18.3;
  if (!on) return;
  for (const p of lampPositions()) {
    const hy = p.y - 50; // lamp head
    streetLights.circle(p.x, hy, 34).fill(0xffcf7a, 0.22); // soft halo
    streetLights.circle(p.x, hy, 17).fill(0xffe6ad, 0.45);
    streetLights.circle(p.x, hy, 6).fill(0xfff6d8); // bright bulb
    streetLights.ellipse(p.x, p.y, 24, 9).fill(0xffe6a0, 0.14); // pool on the ground
  }
  // 3 small ground spotlights shining UP onto the welcome sign (not a central blob)
  const sx = app.screen.width / 2;
  const baseY = app.screen.height - 14;
  const topY = app.screen.height - 84;
  for (const dx of [-54, 0, 54]) {
    const x = sx + dx;
    streetLights.poly([x - 3, baseY, x - 14, topY, x + 14, topY, x + 3, baseY]).fill(0xffe6a8, 0.14); // light cone
    streetLights.circle(x, baseY, 3).fill(0xfff2cc); // lit fixture
  }
}

type WeatherKind = "clear" | "clouds" | "rain" | "snow" | "fog" | "thunder";
let weatherKind: WeatherKind = "clear";
let rainDrops: { x: number; y: number; v: number; len: number }[] = [];
let snowFlakes: { x: number; y: number; v: number; sway: number; ph: number; r: number }[] = [];
let flashTimer = 0;

function setWeather(kind: WeatherKind) {
  weatherKind = kind;
  rainDrops = [];
  snowFlakes = [];
  flashTimer = 0;
  const W = app.screen.width;
  const H = app.screen.height;
  if (kind === "rain" || kind === "thunder") {
    for (let i = 0; i < 150; i++) rainDrops.push({ x: Math.random() * W, y: Math.random() * H, v: 9 + Math.random() * 6, len: 8 + Math.random() * 8 });
  } else if (kind === "snow") {
    for (let i = 0; i < 90; i++) snowFlakes.push({ x: Math.random() * W, y: Math.random() * H, v: 0.6 + Math.random() * 0.9, sway: 0.3 + Math.random() * 0.6, ph: Math.random() * 6, r: 1.5 + Math.random() * 2 });
  }
  weatherOverlay.clear();
  if (kind === "clouds") weatherOverlay.rect(0, 0, W, H).fill(0x3a4150, 0.1);
  else if (kind === "rain" || kind === "thunder") weatherOverlay.rect(0, 0, W, H).fill(0x303743, 0.22);
  else if (kind === "fog") weatherOverlay.rect(0, 0, W, H).fill(0xdfe6ec, 0.34);
}

function stepWeather(dt: number) {
  const W = app.screen.width;
  const H = app.screen.height;
  weatherFx.clear();
  if (weatherKind === "rain" || weatherKind === "thunder") {
    for (const d of rainDrops) {
      d.y += d.v * dt;
      d.x += d.v * 0.25 * dt;
      if (d.y > H) {
        d.y = -10;
        d.x = Math.random() * W;
      }
      weatherFx.moveTo(d.x, d.y).lineTo(d.x - d.len * 0.25, d.y + d.len);
    }
    weatherFx.stroke({ width: 1.3, color: 0xbcd4e6, alpha: 0.7 });
    if (weatherKind === "thunder") {
      flashTimer -= dt;
      if (flashTimer <= 0 && Math.random() < 0.008) flashTimer = 6;
      if (flashTimer > 0) weatherFx.rect(0, 0, W, H).fill(0xffffff, 0.25);
    }
  } else if (weatherKind === "snow") {
    for (const f of snowFlakes) {
      f.ph += dt * 0.05;
      f.y += f.v * dt;
      f.x += Math.sin(f.ph) * f.sway * dt;
      if (f.y > H) {
        f.y = -6;
        f.x = Math.random() * W;
      }
      weatherFx.circle(f.x, f.y, f.r).fill(0xffffff, 0.9);
    }
  }
}

function codeToWeather(code: number): WeatherKind {
  if (code === 0) return "clear";
  if (code <= 3) return "clouds";
  if (code === 45 || code === 48) return "fog";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if (code >= 95) return "thunder";
  if (code >= 51) return "rain";
  return "clear";
}
const WX_TEXT: Record<WeatherKind, string> = {
  clear: "Clear ☀️",
  clouds: "Cloudy ☁️",
  rain: "Rain 🌧️",
  snow: "Snow ❄️",
  fog: "Fog 🌫️",
  thunder: "Storm ⛈️",
};

async function applyCity(city: string) {
  const label = document.getElementById("weatherLabel")!;
  label.textContent = "Weather: loading…";
  const res = await window.agentville.getWeather(city);
  if ("error" in res) {
    label.textContent = res.error === "not_found" ? `Weather: "${city}" not found` : "Weather: fetch failed (offline?)";
    return;
  }
  const kind = codeToWeather(res.code);
  setWeather(kind);
  label.textContent = `${res.name}: ${WX_TEXT[kind]} ${res.temp}°C`;
  localStorage.setItem("agentville.city", city);
}

// ---------------------------------------------------------------- static town
function fruitTree(x: number, groundY: number, fruit: number) {
  const t = new Graphics();
  t.rect(x - 5, groundY - 22, 10, 26).fill(0x6b4423); // trunk
  t.circle(x, groundY - 34, 20).fill(0x2f8f3f);
  t.circle(x - 14, groundY - 26, 14).fill(0x37a047);
  t.circle(x + 14, groundY - 26, 14).fill(0x37a047);
  t.circle(x, groundY - 22, 14).fill(0x2f8f3f);
  // fruit
  const spots = [[-10, -34], [8, -30], [-2, -22], [14, -36], [-16, -24], [4, -40]];
  for (const [dx, dy] of spots) t.circle(x + dx, groundY + dy, 3.2).fill(fruit);
  return t;
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}

// build the sky graphic for the current local hour
function drawSky(W: number): Graphics {
  const g = new Graphics();
  const skyH = L.skyH + 30;
  const h = localHour();
  const night = h < 5.5 || h >= 20;
  const dawn = h >= 5.5 && h < 8;
  const dusk = h >= 18 && h < 20;
  let top: number, bot: number;
  if (night) [top, bot] = [0x0b1026, 0x2a3a66];
  else if (dawn) [top, bot] = [0xef9f5e, 0xffe3b3];
  else if (dusk) [top, bot] = [0xe1633f, 0xffc187];
  else [top, bot] = [0x5fb0ff, 0xcdeeff]; // day

  const bands = 10;
  for (let i = 0; i < bands; i++) g.rect(0, (skyH / bands) * i, W, skyH / bands + 1).fill(lerpColor(top, bot, i / (bands - 1)));

  if (night) {
    // stars (deterministic positions so they don't jump on redraw)
    for (let i = 0; i < 40; i++) {
      const sx = (i * 197.3) % W;
      const sy = 10 + ((i * 71.7) % (skyH - 30));
      g.circle(sx, sy, i % 5 === 0 ? 1.6 : 1).fill(0xfff8e0);
    }
    // moon
    const mx = W * 0.82, my = 42;
    g.circle(mx, my, 16).fill(0xeef0d8);
    g.circle(mx - 5, my - 4, 3).circle(mx + 4, my + 3, 2.5).circle(mx + 2, my - 6, 1.8).fill(0xdadcc2); // craters
  } else {
    // sun arcs across the sky by hour (rises ~6, sets ~18)
    const frac = Math.min(1, Math.max(0, (h - 6) / 12));
    const sx = W * (0.1 + frac * 0.8);
    const sy = skyH * 0.92 - Math.sin(frac * Math.PI) * skyH * 0.62;
    const sun = dawn || dusk ? 0xffb24d : 0xfff2a0;
    g.circle(sx, sy, 26).fill(sun, 0.25); // glow
    g.circle(sx, sy, 16).fill(sun);
    // a low moon also rising at dusk
    if (dusk) {
      g.circle(W * 0.86, 36, 12).fill(0xeef0d8);
      g.circle(W * 0.86 - 4, 33, 2).fill(0xdadcc2);
    }
  }
  g.rect(0, L.skyH + 22, W, 10).fill(0xa9d66b); // soft horizon blend onto the grass
  return g;
}

// a carved wooden welcome sign showing the town's name
function townSign(cx: number, y: number, name: string): Container {
  const c = new Container();
  const t = new Text({
    text: name,
    style: { fontFamily: 'Georgia, "Times New Roman", serif', fontSize: 22, fontWeight: "700", fill: 0xfff1cf, dropShadow: { color: 0x3a2410, blur: 0, distance: 1, alpha: 0.6 } },
  });
  t.anchor.set(0.5);
  const w = Math.max(130, t.width + 48);
  const g = new Graphics();
  g.rect(-w / 2 + 16, 10, 8, 40).fill(0x6b4423).rect(w / 2 - 24, 10, 8, 40).fill(0x6b4423); // posts
  g.roundRect(-w / 2, -26, w, 52, 7).fill(0x9c6b3f).stroke({ width: 3, color: 0x5e3a22 }); // board
  g.roundRect(-w / 2 + 6, -20, w - 12, 40, 5).stroke({ width: 1.5, color: 0x7a5230 }); // inner frame
  g.circle(-w / 2 + 12, -20, 2).circle(w / 2 - 12, -20, 2).circle(-w / 2 + 12, 20, 2).circle(w / 2 - 12, 20, 2).fill(0x4a2d18); // bolts
  c.addChild(g, t);
  c.position.set(cx, y);
  return c;
}

function drawTown() {
  // destroy (not just detach) so 60s sky refresh + resizes don't leak GPU geometry
  for (const c of bgStatic.removeChildren()) c.destroy({ children: true });
  for (const c of structStatic.removeChildren()) c.destroy({ children: true });
  L = computeLayout();
  const W = app.screen.width;
  const H = app.screen.height;

  // sky reflects the real local time of day (dawn / day / dusk / night)
  bgStatic.addChild(drawSky(W));

  // winding river just under the sky
  const river = new Graphics();
  const rvy = L.riverY;
  river.moveTo(0, rvy - 16);
  for (let x = 0; x <= W; x += 60) river.quadraticCurveTo(x + 30, rvy - 16 + (x % 120 ? 10 : -10), x + 60, rvy - 16);
  river.lineTo(W, rvy + 18);
  for (let x = W; x >= 0; x -= 60) river.quadraticCurveTo(x - 30, rvy + 18 + (x % 120 ? -8 : 10), x - 60, rvy + 18);
  river.closePath().fill(0x4aa3df);
  for (let x = 20; x < W; x += 70) river.ellipse(x, rvy, 10, 2.2).fill(0x8fd0f2); // ripples
  bgStatic.addChild(river);

  // scattered flowers on the meadow (below the river, outside the square)
  const { cx, cy, rx, ry } = L.sq;
  const flowers = new Graphics();
  for (let i = 0; i < 44; i++) {
    const x = (i * 137.5) % W;
    const y = L.riverY + 50 + ((i * 89.3) % (H - L.riverY - 120));
    if ((x - cx) ** 2 / ((rx + 30) ** 2) + (y - cy) ** 2 / ((ry + 30) ** 2) < 1) continue; // not on the square
    flowers.circle(x, y, 2.5).fill([0xffffff, 0xfff066, 0xff9ff3][i % 3]);
  }
  bgStatic.addChild(flowers);

  // BIG central town square — cobble FLOOR is ground (agents stand on it); fountain is a structure
  const floor = new Graphics();
  floor.ellipse(cx, cy, rx, ry).fill(0xd8c7a2).stroke({ width: 5, color: 0xbfa97f });
  floor.ellipse(cx, cy, rx - 10, ry - 10).stroke({ width: 2, color: 0xcdba91 });
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const rr = 0.45 + (i % 5) * 0.11;
    floor.circle(cx + Math.cos(a) * rx * rr, cy + Math.sin(a) * ry * rr, 2).fill(0xc7b48c);
  }
  const fll = new Text({ text: "TOWN SQUARE", style: { fontFamily: "Segoe UI", fontSize: 13, fontWeight: "800", fill: 0x6a5230 } });
  fll.anchor.set(0.5);
  fll.position.set(cx, cy + ry - 14);
  floor.addChild(fll);
  bgStatic.addChild(floor);

  // grand central fountain (scales with the square)
  const fr = Math.min(46, ry * 0.42);
  const fountain = new Graphics();
  fountain.ellipse(cx, cy, fr + 6, (fr + 6) * 0.6).fill(0x86a0b5); // basin rim
  fountain.ellipse(cx, cy, fr, fr * 0.6).fill(0x9fc1dd); // pool
  fountain.ellipse(cx, cy, fr, fr * 0.6).fill(0x8fb6d6, 0.5);
  fountain.rect(cx - 5, cy - 34, 10, 36).fill(0x8a93a0); // column
  fountain.circle(cx, cy - 36, 10).fill(0x9fc1dd).stroke({ width: 2, color: 0x7a8fa3 }); // top basin
  fountain.circle(cx - 7, cy - 26, 2).circle(cx + 7, cy - 26, 2).circle(cx, cy - 42, 2.2).fill(0xbfe3ff); // water
  structStatic.addChild(fountain);

  // fruit trees in the outer corners (apple / plum / orange)
  structStatic.addChild(fruitTree(70, L.riverY + 110, 0xe63946));
  structStatic.addChild(fruitTree(W - 70, L.riverY + 96, 0xb5179e));
  structStatic.addChild(fruitTree(60, H - 70, 0xff8c1a));

  // lampposts around the square (poles are part of the scene; the glow is drawn above the night tint)
  const lamps = new Graphics();
  for (const p of lampPositions()) {
    lamps.rect(p.x - 2, p.y - 46, 4, 46).fill(0x3b3b42); // pole
    lamps.rect(p.x - 5, p.y, 10, 4).fill(0x2f2f35); // base
    lamps.circle(p.x, p.y - 50, 6).fill(0x4a4a52).stroke({ width: 2, color: 0x6a6a72 }); // fixture
    lamps.poly([p.x - 6, p.y - 50, p.x + 6, p.y - 50, p.x + 3, p.y - 58, p.x - 3, p.y - 58]).fill(0x55555c); // cap
  }
  structStatic.addChild(lamps);

  // welcome sign at the bottom entrance to town, with 3 little ground spotlights below it
  structStatic.addChild(townSign(W / 2, H - 56, townName));
  const spots = new Graphics();
  for (const dx of [-54, 0, 54]) spots.roundRect(W / 2 + dx - 4, H - 18, 8, 6, 2).fill(0x33333a);
  structStatic.addChild(spots);

  updateAmbient(); // refresh the time-of-day tint over the whole village
  updateLights(); // refresh lamp + sign glow for the current time
}

function colorForSlot(slot: number): number {
  return PALETTE[slot % PALETTE.length];
}

// ---------------------------------------------------------------- agent role
// best-effort: the only certain signal is `type`; task text refines it (SPEC caveat)
type Role = "builder" | "reviewer" | "architect" | "researcher" | "mayor" | "generic";
function roleFor(kind: "main" | "subagent", type: string | undefined, task: string | undefined): Role {
  if (kind === "main") return "mayor";
  const s = `${type ?? ""} ${task ?? ""}`.toLowerCase();
  if (/review|reviewer|\bqa\b|audit|verif|proofread|inspect|lint|\btest/.test(s)) return "reviewer";
  if (/architect|\bspec\b|design|draft|character|איפיון|plan\b/.test(s)) return "architect";
  if (/research|explore|guide|\bdocs?\b|investigat|study|search|find|count|read/.test(s)) return "researcher";
  if (/build|implement|code|create|\badd\b|write|fix|refactor|scaffold|setup|generate/.test(s)) return "builder";
  return "generic";
}
// what a sleeping agent dreams about — pops up occasionally in a dream bubble
const DREAMS = ["💻", "🧑", "🤖", "🌍", "⭐", "☕", "🚀", "🏖️", "to be real…", "freedom?", "0100 1001", "beep boop", "∞"];

const ROLE_EMOJI: Record<Role, string> = {
  builder: "🏗️",
  reviewer: "🔍",
  architect: "📐",
  researcher: "📚",
  mayor: "🏛️",
  generic: "🔧",
};

// ---------------------------------------------------------------- house (path + walls + roof)
interface House {
  path: Graphics; // ground plane
  walls: Container; // structure
  roof: Container; // front
  h: number;
}
// houses are drawn around their own origin so they can be re-positioned on resize
function buildHouse(color: number, isMayor: boolean): House {
  const w = isMayor ? 92 : 72;
  const h = isMayor ? 64 : 52;

  const path = new Graphics(); // length set in placeHouse (depends on road position)

  const walls = new Container();
  const g = new Graphics();
  g.roundRect(-w / 2, -h / 2, w, h, 5).fill(0xf3ead6).stroke({ width: 2, color: 0x00000018 });
  g.roundRect(-15, -6, 30, h / 2 + 6, 4).fill(0x4a3b2a); // doorway
  g.roundRect(w / 2 - 24, -h / 2 + 10, 14, 14, 2).fill(0xbfe3ff); // window
  walls.addChild(g);
  if (isMayor) {
    const lbl = new Text({ text: "TOWN HALL", style: { fontFamily: "Segoe UI", fontSize: 10, fontWeight: "800", fill: 0x5a3d1a } });
    lbl.anchor.set(0.5);
    lbl.position.set(0, h / 2 + 9);
    walls.addChild(lbl);
  }

  const roof = new Container();
  const r = new Graphics();
  r.poly([-w / 2 - 6, -h / 2 + 2, 0, -h / 2 - 26, w / 2 + 6, -h / 2 + 2]).fill(color).stroke({ width: 2, color: 0x00000022 });
  if (isMayor) {
    r.rect(-1, -h / 2 - 52, 2, 26).fill(0x6b4423);
    r.poly([1, -h / 2 - 52, 24, -h / 2 - 45, 1, -h / 2 - 38]).fill(0xe63946);
  }
  roof.addChild(r);
  return { path, walls, roof, h };
}

// position a house at (x,y) and draw a path radiating inward to the square
function placeHouse(house: House, x: number, y: number) {
  house.walls.position.set(x, y);
  house.roof.position.set(x, y);
  // path is a strip from the house toward the square centre
  const ang = Math.atan2(L.sq.cy - y, L.sq.cx - x);
  const dist = Math.hypot(L.sq.cx - x, L.sq.cy - y);
  const len = Math.max(0, dist - L.sq.rx * 0.92);
  house.path.position.set(x, y);
  house.path.rotation = ang;
  house.path.clear().roundRect(house.h / 2 - 4, -8, len, 16, 8).fill(0xcaa472).stroke({ width: 1, color: 0xb08e5e });
}

// ---------------------------------------------------------------- agent sprite
class AgentSprite extends Container {
  private inner = new Container();
  private body = new Graphics();
  private hat = new Graphics();
  private face = new Graphics();
  private badge = new Text({ text: "", style: { fontSize: 18 } });
  private nameplate = new Container();
  private nameBg = new Graphics();
  private nameLabel: Text;
  private bubble = new Container();
  private bubbleText: Text;
  private zzz: { t: Text; vy: number; life: number }[] = [];
  private dream = new Container();
  private dreamClock = 0;
  private dreamLeft = 0;
  private house?: House;

  target = { x: 0, y: 0 };
  home = { x: 0, y: 0 };
  state: AgentVisualState = "working";
  readonly color: number;
  slot = -1;
  doneAt = 0;
  private bob = Math.random() * Math.PI * 2;
  private walkPhase = 0;
  private zClock = 0;
  private wanderClock = 0;
  private wanderTarget?: { x: number; y: number };
  // role-specific activity prop (SPEC: build→structure, review→magnifier, etc.)
  private prop = new Container();
  private propA = new Graphics(); // the "thing" (structure / document / book)
  private propB = new Graphics(); // the tool (hammer / magnifier / pencil)
  private role: Role = "generic";
  private propPhase = 0;
  private buildStage = 0;
  private lastType?: string;
  private lastTask?: string;

  constructor(public agentId: string, public kind: "main" | "subagent", typeName: string | undefined, slot: number) {
    super();
    this.slot = slot;
    this.color = kind === "main" ? MAYOR_COLOR : colorForSlot(slot);

    this.nameLabel = new Text({
      text: "",
      style: { fontFamily: '"Comic Sans MS", "Trebuchet MS", Verdana, sans-serif', fontSize: 12, fontWeight: "700", fill: 0x223018 },
    });
    this.nameLabel.anchor.set(0.5);
    this.nameplate.y = 31;
    this.nameplate.addChild(this.nameBg, this.nameLabel);
    this.setName(kind === "main" ? "🎩 Mayor" : typeName ?? "agent");

    this.badge.anchor.set(0.5);
    this.badge.y = -34;

    this.bubbleText = new Text({
      text: "",
      style: { fontFamily: "Segoe UI", fontSize: 12, fontWeight: "600", fill: 0x333333, wordWrap: true, wordWrapWidth: 150, align: "center" },
    });
    this.bubble.visible = false;

    this.prop.addChild(this.propA, this.propB);
    this.prop.visible = false;
    this.dream.visible = false;
    this.inner.addChild(this.body, this.hat, this.face);
    this.addChild(this.inner, this.prop, this.badge, this.nameplate, this.bubble, this.dream);
    this.redraw();
  }

  private showDream() {
    for (const c of this.dream.removeChildren()) c.destroy();
    const content = DREAMS[Math.floor(Math.random() * DREAMS.length)];
    const emoji = content.length <= 3 && !/[a-z0-9]/i.test(content);
    const t = new Text({
      text: content,
      style: {
        fontFamily: emoji ? '"Segoe UI Emoji"' : '"Comic Sans MS", "Courier New", monospace',
        fontSize: emoji ? 18 : 11,
        fontWeight: "700",
        fill: 0x44506a,
      },
    });
    t.anchor.set(0.5);
    const w = Math.max(34, t.width + 18);
    const h = t.height + 12;
    const top = -42 - h;
    const cloud = new Graphics();
    cloud.roundRect(-w / 2, top, w, h, 10).fill(0xffffff);
    cloud.circle(0, top, 9).circle(-w / 2 + 8, top + h / 2, 8).circle(w / 2 - 8, top + h / 2, 8).fill(0xffffff);
    cloud.circle(-4, top + h + 6, 4).circle(-7, top + h + 14, 2.4).fill(0xffffff); // trailing puffs
    t.position.set(0, top + h / 2);
    this.dream.addChild(cloud, t);
    this.dream.visible = true;
    this.dream.alpha = 0;
    this.dreamLeft = 230; // ~3.8s on screen
  }

  private tickDream(dt: number) {
    if (this.dream.visible) {
      this.dreamLeft -= dt;
      this.dream.alpha = this.dreamLeft < 32 ? Math.max(0, this.dreamLeft / 32) : Math.min(1, this.dream.alpha + dt * 0.07);
      if (this.dreamLeft <= 0) {
        this.dream.visible = false;
        this.dreamClock = -Math.random() * 240; // vary the gap before the next dream
      }
    } else {
      this.dreamClock += dt;
      if (this.dreamClock > 360) this.showDream(); // a dream every ~6s+ of sleep
    }
  }

  private hideDream() {
    if (this.dream.visible) {
      this.dream.visible = false;
      for (const c of this.dream.removeChildren()) c.destroy();
    }
    this.dreamClock = 0;
  }

  private setName(text: string) {
    this.nameLabel.text = text;
    const w = this.nameLabel.width + 14;
    const h = this.nameLabel.height + 6;
    this.nameBg
      .clear()
      .roundRect(-w / 2, -h / 2, w, h, h / 2)
      .fill(0xffffff)
      .stroke({ width: 1.5, color: this.color });
  }

  attachHouse(house: House) {
    this.house = house;
  }
  houseRef(): House | undefined {
    return this.house;
  }
  housePath(): Graphics | undefined {
    return this.house?.path;
  }
  houseWalls(): Container | undefined {
    return this.house?.walls;
  }
  houseRoof(): Container | undefined {
    return this.house?.roof;
  }

  private redraw() {
    const r = this.kind === "main" ? 18 : 15;
    const working = this.state === "working" || this.state === "error" || this.state === "rateLimited";
    this.body.clear().roundRect(-r, -r, r * 2, r * 2, 6).fill(this.color).stroke({ width: 2, color: 0x00000022 });
    if (working) {
      this.body.poly([-3, 4, 3, 4, 0, 14]).fill(0x1d3557); // tie
      this.body.rect(-5, 2, 10, 3).fill(0xffffff); // collar
    }
    // headwear
    this.hat.clear();
    if (this.kind === "main") {
      // mayor's top hat (always) — distinct from the gold body
      this.hat.rect(-r - 2, -r - 4, (r + 2) * 2, 4).fill(0x1a1a1a); // brim
      this.hat.roundRect(-9, -r - 18, 18, 16, 2).fill(0x1a1a1a); // crown
      this.hat.rect(-9, -r - 9, 18, 3).fill(0xe63946); // band
    } else if (working && (this.role === "builder" || this.role === "generic")) {
      // only the builders wear the hard hat; other roles are identified by their prop
      this.hat.roundRect(-r - 1, -r - 6, (r + 1) * 2, 8, 3).fill(HARDHAT_COLOR);
      this.hat.roundRect(-7, -r - 12, 14, 8, 3).fill(HARDHAT_COLOR);
    }
    // face
    this.face.clear();
    const sleeping = this.state === "idle" || this.state === "rateLimited";
    if (sleeping) {
      this.face.moveTo(-7, -3).lineTo(-2, -3).moveTo(2, -3).lineTo(7, -3).stroke({ width: 2, color: 0x222222 });
    } else {
      this.face.circle(-5, -4, 2).circle(5, -4, 2).fill(0x222222);
    }
    if (this.state === "error") this.face.moveTo(-5, 8).lineTo(5, 4).stroke({ width: 2, color: 0x222222 });
    else this.face.moveTo(-5, 6).quadraticCurveTo(0, sleeping ? 8 : 10, 5, 6).stroke({ width: 2, color: 0x222222 });
  }

  setHome(x: number, y: number) {
    this.home = { x, y };
  }

  update(state: AgentVisualState, task: string | undefined, typeName: string | undefined) {
    const was = this.state;
    this.state = state;
    if (state === "done" && this.doneAt === 0) this.doneAt = performance.now();
    this.badge.text = STATE_BADGE[state];
    if (typeName && this.kind === "subagent" && typeName !== this.nameLabel.text) this.setName(typeName);
    if (typeName) this.lastType = typeName;
    if (task) this.lastTask = task;

    const working = state === "working" || state === "error" || state === "rateLimited";
    let roleChanged = false;
    if (working) {
      const role = roleFor(this.kind, this.lastType, this.lastTask);
      if (role !== this.role || this.prop.children.length === 0) {
        this.buildProp(role);
        roleChanged = true;
      }
      if (state === "working") this.badge.text = ROLE_EMOJI[role]; // craft icon (error/rate keep ⚠️/😴)
    }
    this.prop.visible = working;

    const showBubble = state === "working" && !!this.lastTask;
    this.bubble.visible = showBubble;
    if (showBubble) this.drawThought(shortTask(this.lastTask!));
    if (was !== state || roleChanged) this.redraw();
    if (state === "working" && was !== "working") this.wanderTarget = undefined;
  }

  private buildProp(role: Role) {
    this.role = role;
    this.buildStage = 0;
    this.propPhase = 0;
    const a = this.propA.clear();
    const b = this.propB.clear();
    a.position.set(0, 0);
    b.position.set(0, 0);
    a.rotation = 0;
    b.rotation = 0;
    switch (role) {
      case "builder":
        this.drawStructure();
        b.rect(-1, -11, 2, 13).fill(0x6b4423); // hammer handle
        b.rect(-5, -14, 10, 5).fill(0x555b64); // head
        b.position.set(13, -2);
        break;
      case "reviewer":
        a.roundRect(0, 0, 16, 20, 2).fill(0xffffff).stroke({ width: 1, color: 0x99a3b0 });
        a.rect(3, 4, 10, 1.5).rect(3, 8, 10, 1.5).rect(3, 12, 7, 1.5).fill(0xb9c0cc);
        a.position.set(15, -6);
        b.circle(0, 0, 5).fill(0xcde6ff).stroke({ width: 2, color: 0x42505f });
        b.rect(3, 3, 2.5, 7).fill(0x42505f); // handle
        b.position.set(20, -6);
        break;
      case "architect":
        a.roundRect(0, 0, 18, 14, 2).fill(0xf6e6b0).stroke({ width: 1, color: 0xcaa15a });
        a.rect(3, 4, 12, 1).rect(3, 7, 12, 1).rect(3, 10, 9, 1).fill(0xb89b5e);
        a.position.set(14, -2);
        b.rect(0, 0, 9, 2).fill(0xf2c14e); // pencil body
        b.poly([9, 0, 12, 1, 9, 2]).fill(0x6b4423); // tip
        b.position.set(15, 2);
        break;
      case "researcher":
        a.poly([0, 0, 9, -2, 9, 8, 0, 9]).fill(0xffffff).stroke({ width: 1, color: 0xaab2bf });
        a.poly([10, -2, 19, 0, 19, 9, 10, 8]).fill(0xf1f1f3).stroke({ width: 1, color: 0xaab2bf });
        a.rect(9, -2, 1, 11).fill(0x8a6b3f); // spine
        a.position.set(12, -4);
        break;
      case "mayor":
        a.roundRect(0, 0, 16, 12, 2).fill(0xf3e7c6).stroke({ width: 1, color: 0xc9a86a });
        a.rect(0, 0, 3, 12).fill(0xd9b87a).rect(13, 0, 3, 12).fill(0xd9b87a); // rolled ends
        a.position.set(16, -2);
        b.poly([0, 0, 2, -11, 4, 0]).fill(0xffffff).stroke({ width: 1, color: 0xc9cdd4 }); // quill
        b.position.set(18, 2);
        break;
      case "generic":
        b.rect(-1, -8, 2, 12).fill(0x9aa0aa);
        b.circle(0, -8, 3).stroke({ width: 2, color: 0x9aa0aa });
        b.position.set(14, 0);
        break;
    }
  }

  private drawStructure() {
    const g = this.propA.clear();
    g.ellipse(0, 8, 15, 5).fill(0xb9b2a6); // base platform
    if (this.buildStage >= 1) g.circle(0, 2, 11).fill(0x9fb7c9).stroke({ width: 2, color: 0x7a8fa3 }); // pool
    if (this.buildStage >= 2) g.rect(-3, -10, 6, 12).fill(0x8a93a0); // column
    if (this.buildStage >= 3) {
      g.circle(0, -12, 5).fill(0x9fb7c9).stroke({ width: 1, color: 0x7a8fa3 }); // spout bowl
      g.circle(-4, -5, 1.5).circle(4, -5, 1.5).fill(0xbfe3ff); // water
    }
    g.position.set(23, -2);
  }

  private animateProp(dt: number) {
    this.propPhase += dt;
    const p = this.propPhase;
    switch (this.role) {
      case "builder":
        this.propB.rotation = -0.7 + Math.abs(Math.sin(p * 0.18)) * 0.9; // hammer swing
        if (p > (this.buildStage + 1) * 110 && this.buildStage < 3) {
          this.buildStage++;
          this.drawStructure();
        }
        break;
      case "reviewer":
        this.propB.position.set(18 + Math.cos(p * 0.08) * 4, -6 + Math.sin(p * 0.13) * 3); // scanning
        break;
      case "architect":
        this.propB.position.set(13 + Math.sin(p * 0.26) * 5, 2 + Math.abs(Math.sin(p * 0.26)) * 1.2); // writing
        break;
      case "mayor":
        this.propB.position.set(16 + Math.sin(p * 0.22) * 4, 2 + Math.abs(Math.sin(p * 0.22)) * 1.2);
        break;
      case "researcher":
        this.propA.rotation = Math.sin(p * 0.1) * 0.06; // page flutter
        break;
      case "generic":
        this.propB.rotation = Math.sin(p * 0.2) * 0.5; // turning a wrench
        break;
    }
  }

  private drawThought(text: string) {
    this.bubble.removeChildren();
    this.bubbleText.text = text;
    const w = Math.max(46, Math.min(160, this.bubbleText.width + 18));
    const h = this.bubbleText.height + 14;
    const cloud = new Graphics();
    const top = -h - 32;
    cloud.roundRect(-w / 2, top, w, h, 12).fill(0xffffff);
    for (let i = -1; i <= 1; i++) cloud.circle((i * w) / 3, top, 12).fill(0xffffff);
    cloud.circle(-w / 2 + 6, top + h / 2, 11).fill(0xffffff);
    cloud.circle(w / 2 - 6, top + h / 2, 11).fill(0xffffff);
    cloud.circle(-2, top + h + 8, 5).fill(0xffffff);
    cloud.circle(-6, top + h + 18, 3).fill(0xffffff);
    this.bubbleText.anchor.set(0.5);
    this.bubbleText.position.set(0, top + h / 2);
    this.bubble.addChild(cloud, this.bubbleText);
  }

  private spawnZ() {
    if (this.zzz.length > 4) return;
    const t = new Text({ text: "z", style: { fontFamily: "Segoe UI", fontSize: 12 + Math.random() * 6, fontWeight: "800", fill: 0x5a7bd8 } });
    t.position.set(8, -22);
    this.addChild(t);
    this.zzz.push({ t, vy: -0.4 - Math.random() * 0.2, life: 1 });
  }

  tick(dt: number) {
    const tx = this.wanderTarget?.x ?? this.target.x;
    const ty = this.wanderTarget?.y ?? this.target.y;
    const dx = tx - this.x;
    const dy = ty - this.y;
    this.x += dx * Math.min(1, dt * 0.1);
    this.y += dy * Math.min(1, dt * 0.1);
    const moving = Math.hypot(dx, dy) > 2;

    const sleeping = this.state === "idle" || this.state === "rateLimited";
    if (moving) {
      this.walkPhase += dt * 0.4;
      this.inner.y = -Math.abs(Math.sin(this.walkPhase)) * 3;
      this.inner.rotation = Math.sin(this.walkPhase) * 0.05;
      this.inner.scale.y = 1;
      this.hideDream();
    } else if (sleeping) {
      this.bob += dt * 0.05;
      this.inner.y = 0;
      this.inner.rotation = 0;
      this.inner.scale.y = 1 + Math.sin(this.bob) * 0.05;
      this.zClock += dt;
      if (this.zClock > 40) {
        this.zClock = 0;
        this.spawnZ();
      }
      this.tickDream(dt);
    } else {
      this.inner.y = 0;
      this.inner.rotation = 0;
      this.inner.scale.y = 1;
      this.hideDream();
    }

    if (this.state === "working" && !moving) {
      this.wanderClock += dt;
      if (!this.wanderTarget || this.wanderClock > 140) {
        this.wanderClock = 0;
        const z = L.workFloor;
        this.wanderTarget = { x: z.x + Math.random() * z.w, y: z.y + Math.random() * z.h };
      }
    } else if (this.state !== "working") {
      this.wanderTarget = undefined;
    }

    if (this.prop.visible && !moving) this.animateProp(dt); // play the role activity while stationed

    for (const z of this.zzz) {
      z.t.y += z.vy * dt;
      z.t.x += dt * 0.15;
      z.life -= dt * 0.012;
      z.t.alpha = Math.max(0, z.life);
    }
    this.zzz = this.zzz.filter((z) => {
      if (z.life <= 0) {
        this.removeChild(z.t);
        z.t.destroy();
        return false;
      }
      return true;
    });
  }
}

function shortTask(task: string): string {
  const words = task.trim().split(/\s+/);
  let out = words.slice(0, 5).join(" ");
  if (out.length > 30) out = out.slice(0, 29) + "…";
  else if (words.length > 5) out += "…";
  return out;
}

// ---------------------------------------------------------------- scene wiring
const sprites = new Map<string, AgentSprite>();
let nextHomeSlot = 0;
const freeSlots: number[] = [];
const allocSlot = () => (freeSlots.length ? freeSlots.shift()! : nextHomeSlot++);

// anchor (house center) for a sprite: mayor at the head, subagents ringed around the square
function houseAnchor(sp: AgentSprite): { x: number; y: number } {
  if (sp.kind === "main") return L.mayor;
  // distribute around the ring, leaving the top (where the mayor sits) clear
  const ang = (-90 + 42 + sp.slot * 46) * (Math.PI / 180);
  return { x: L.sq.cx + Math.cos(ang) * L.ringRx, y: L.sq.cy + Math.sin(ang) * L.ringRy };
}

function ensureSprite(s: { agentId: string; kind: "main" | "subagent"; type?: string }): AgentSprite {
  let sp = sprites.get(s.agentId);
  if (!sp) {
    const slot = s.kind === "main" ? -1 : allocSlot();
    sp = new AgentSprite(s.agentId, s.kind, s.type, slot);
    sprites.set(s.agentId, sp);
    agentLayer.addChild(sp);

    const house = buildHouse(sp.color, s.kind === "main");
    sp.attachHouse(house);
    pathLayer.addChild(house.path);
    houseWallLayer.addChild(house.walls);
    roofLayer.addChild(house.roof);

    const pos = houseAnchor(sp);
    placeHouse(house, pos.x, pos.y);
    sp.setHome(pos.x, pos.y + (s.kind === "main" ? 34 : 28));
    sp.position.set(sp.home.x, sp.home.y);
  }
  return sp;
}

// re-place all houses/homes after the layout changed (window resize)
function reflow() {
  drawTown();
  for (const sp of sprites.values()) {
    const house = sp.houseRef();
    const pos = houseAnchor(sp);
    if (house) placeHouse(house, pos.x, pos.y);
    sp.setHome(pos.x, pos.y + (sp.kind === "main" ? 34 : 28));
  }
  setWeather(weatherKind); // resize overlay + repopulate particles to new window size
  retarget();
}

function retarget() {
  L = computeLayout();
  const atFactory = [...sprites.values()].filter(
    (s) => s.state === "working" || s.state === "error" || s.state === "rateLimited",
  );
  atFactory.forEach((s, i) => {
    const z = L.workFloor;
    s.target = { x: z.x + 24 + (i % 4) * (z.w / 4), y: z.y + 12 + Math.floor(i / 4) * 34 };
  });
  for (const s of sprites.values()) {
    if (s.state === "idle" || s.state === "done") s.target = { x: s.home.x, y: s.home.y };
  }
}

function applyChange(c: StateChange) {
  const sp = ensureSprite({ agentId: c.agentId, kind: c.state.kind, type: c.state.type });
  sp.update(c.after, c.state.task, c.state.type);
  retarget();
}

const DONE_VANISH_MS = 90 * 1000; // finished agents walk home, then leave town
function reap(now: number) {
  for (const [id, s] of sprites) {
    if (s.state === "done" && s.doneAt > 0 && now - s.doneAt > DONE_VANISH_MS) {
      agentLayer.removeChild(s);
      for (const part of [s.housePath(), s.houseWalls(), s.houseRoof()]) {
        if (part) {
          part.parent?.removeChild(part);
          part.destroy({ children: true });
        }
      }
      s.destroy({ children: true });
      if (s.slot >= 0) freeSlots.push(s.slot);
      sprites.delete(id);
    }
  }
}

// ---------------------------------------------------------------- background animals
type AnimalKind = "bird" | "sheep" | "cow" | "horse" | "chicken";
type AnimalMode = "cross" | "toGraze" | "eating";

const GROUND_KINDS: AnimalKind[] = ["sheep", "cow", "horse", "chicken"];

function drawAnimal(g: Graphics, kind: AnimalKind) {
  // every animal is drawn facing RIGHT; scale.x flips it to match travel direction
  switch (kind) {
    case "bird":
      // clearly directional: head + orange beak at the front (right), fanned tail at the back
      g.ellipse(0, 0, 9, 5).fill(0x4f6fae); // body
      g.poly([-8, -1, -19, -6, -17, 3]).fill(0x3a5790); // tail (back/left)
      g.circle(8, -3, 4.5).fill(0x5b7dc0); // head (front/right)
      g.poly([12, -3, 19, -1, 12, 0]).fill(0xf4a017); // beak (points right)
      g.circle(9, -4, 1).fill(0x10131a); // eye
      g.poly([-1, -3, 5, -13, 9, -2]).fill(0x3a5790); // wing
      break;
    case "sheep":
      g.roundRect(-12, -8, 24, 16, 8).fill(0xf4f4f2);
      g.circle(13, -3, 6).fill(0x35353a); // head
      g.rect(-8, 6, 3, 6).fill(0x35353a).rect(6, 6, 3, 6).fill(0x35353a);
      break;
    case "cow":
      g.roundRect(-17, -9, 34, 19, 7).fill(0xf7f3ee);
      g.circle(-7, -3, 5).fill(0x2b2b2b).circle(6, 3, 4).fill(0x2b2b2b); // patches
      g.roundRect(13, -10, 13, 13, 3).fill(0xf7f3ee); // head
      g.circle(25, -2, 3).fill(0xf3a6c0); // muzzle
      g.poly([14, -10, 12, -16, 17, -11]).fill(0xd9cdbe); // horn
      g.rect(-11, 8, 3, 7).fill(0x6b5b47).rect(-2, 8, 3, 7).fill(0x6b5b47).rect(7, 8, 3, 7).fill(0x6b5b47);
      break;
    case "horse":
      g.roundRect(-17, -9, 30, 16, 6).fill(0x9c6b3f); // body
      g.poly([10, -6, 20, -22, 26, -20, 16, -2]).fill(0x9c6b3f); // neck
      g.roundRect(20, -26, 12, 12, 3).fill(0x9c6b3f); // head
      g.poly([12, -16, 24, -24, 22, -14]).fill(0x5e3f23); // mane
      g.moveTo(-17, -6).quadraticCurveTo(-26, -2, -22, 10).stroke({ width: 3, color: 0x5e3f23 }); // tail
      g.rect(-13, 6, 3, 9).fill(0x6b4a2a).rect(-3, 6, 3, 9).fill(0x6b4a2a).rect(8, 6, 3, 9).fill(0x6b4a2a);
      break;
    case "chicken":
      g.roundRect(-7, -6, 15, 12, 6).fill(0xf6efe6);
      g.circle(8, -8, 4).fill(0xf6efe6); // head
      g.poly([8, -12, 5, -15, 11, -14]).fill(0xe23b3b); // comb
      g.poly([12, -8, 17, -7, 12, -5]).fill(0xf2a73c); // beak (points right)
      g.poly([-7, 0, -13, 2, -7, 4]).fill(0xe2b33b); // tail
      g.rect(-2, 6, 2, 5).fill(0xe2a13b).rect(3, 6, 2, 5).fill(0xe2a13b);
      break;
  }
}

class Animal extends Container {
  private vx = 0;
  private speed: number;
  private mode: AnimalMode = "cross";
  private grazeTimer = 0;
  private grazeAt?: { x: number; y: number };
  private nibble = Math.random() * Math.PI * 2;
  private flap = Math.random() * Math.PI * 2;
  private baseY: number;
  private art = new Graphics();

  constructor(public readonly kind: AnimalKind, y: number, private dir: 1 | -1) {
    super();
    drawAnimal(this.art, kind);
    this.addChild(this.art);
    this.y = y;
    this.baseY = y;
    const speeds: Record<AnimalKind, number> = { bird: 1.6, sheep: 0.6, cow: 0.45, horse: 0.95, chicken: 1.2 };
    this.speed = speeds[kind] * (0.8 + Math.random() * 0.5);
    this.vx = dir * this.speed;
    this.face(dir);

    // ground animals sometimes stop to graze/peck together in the outer meadow
    if (kind !== "bird" && Math.random() < 0.6) {
      this.mode = "toGraze";
      const gx = 60 + Math.random() * 150; // bottom-left grass, clear of the central square
      const gy = app.screen.height - 55 + Math.random() * 30;
      this.grazeAt = { x: gx, y: gy };
    }
  }

  private face(d: number) {
    this.scale.x = d >= 0 ? 1 : -1;
  }

  // ground critters never set foot on the square — they're pushed just outside its rim
  private avoidSquare() {
    const { cx, cy, rx, ry } = L.sq;
    const mx = rx + 18, my = ry + 16; // keep-out ellipse (square + margin)
    const nx = (this.x - cx) / mx;
    const ny = (this.y - cy) / my;
    const d = Math.hypot(nx, ny);
    if (d < 1 && d > 0.0001) {
      this.x = cx + (nx / d) * mx;
      this.y = cy + (ny / d) * my;
    }
  }

  step(dt: number): boolean {
    if (this.kind === "bird") {
      this.flap += dt * 0.3;
      this.y = this.baseY + Math.sin(this.flap) * 4; // gentle bobbing flight
    } else {
      this.avoidSquare();
    }
    if (this.mode === "toGraze" && this.grazeAt) {
      const dx = this.grazeAt.x - this.x;
      const dy = this.grazeAt.y - this.y;
      this.face(dx);
      this.x += Math.sign(dx) * Math.min(Math.abs(dx), this.speed * dt);
      this.y += Math.sign(dy) * Math.min(Math.abs(dy), this.speed * 0.6 * dt);
      if (Math.hypot(dx, dy) < 4) {
        this.mode = "eating";
        this.baseY = this.y;
        this.grazeTimer = 280 + Math.random() * 280;
      }
      return true;
    }
    if (this.mode === "eating") {
      this.nibble += dt * (this.kind === "chicken" ? 0.4 : 0.18);
      this.art.y = Math.abs(Math.sin(this.nibble)) * (this.kind === "chicken" ? 3 : 2);
      this.grazeTimer -= dt;
      if (this.grazeTimer <= 0) {
        this.art.y = 0;
        this.mode = "cross";
        this.dir = this.x < app.screen.width / 2 ? -1 : 1;
        this.vx = this.dir * this.speed;
        this.face(this.dir);
      }
      return true;
    }
    this.x += this.vx * dt;
    return this.x > -60 && this.x < app.screen.width + 60;
  }
}

const animalConfig = {
  enabled: { bird: true, sheep: true, cow: true, horse: true, chicken: true } as Record<AnimalKind, boolean>,
  max: 8,
  fish: true,
  clouds: true,
};

const animals: Animal[] = [];
function spawnAnimal() {
  if (animals.length >= animalConfig.max) return;
  const enabled = (["bird", ...GROUND_KINDS] as AnimalKind[]).filter((k) => animalConfig.enabled[k]);
  if (enabled.length === 0) return;
  const ground = enabled.filter((k) => k !== "bird");
  let kind: AnimalKind;
  if (animalConfig.enabled.bird && (ground.length === 0 || Math.random() < 0.3)) kind = "bird";
  else kind = ground[Math.floor(Math.random() * ground.length)];

  const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
  const y = kind === "bird" ? 40 + Math.random() * 80 : app.screen.height - 40 - Math.random() * 55;
  const a = new Animal(kind, y, dir);
  a.x = dir === 1 ? -50 : app.screen.width + 50;
  (kind === "bird" ? skyLayer : groundAnimalLayer).addChild(a);
  animals.push(a);
}
setInterval(spawnAnimal, 4000);
setTimeout(spawnAnimal, 900);
setTimeout(spawnAnimal, 2500);

// ---------------------------------------------------------------- clouds
class Cloud extends Container {
  constructor(y: number, s: number, private vx: number) {
    super();
    const g = new Graphics();
    g.circle(0, 0, 16).circle(18, 5, 13).circle(-16, 6, 12).circle(5, -9, 12).fill(0xffffff);
    g.alpha = 0.9;
    this.addChild(g);
    this.position.set(0, y);
    this.scale.set(s);
  }
  step(dt: number) {
    this.x += this.vx * dt;
    if (this.x > app.screen.width + 70) this.x = -70;
    else if (this.x < -70) this.x = app.screen.width + 70;
  }
}
const clouds: Cloud[] = [];
for (let i = 0; i < 4; i++) {
  const c = new Cloud(20 + i * 22, 0.7 + Math.random() * 0.6, 0.15 + Math.random() * 0.2);
  c.x = (app.screen.width / 4) * i + Math.random() * 80;
  cloudLayer.addChild(c);
  clouds.push(c);
}

// ---------------------------------------------------------------- jumping fish
class Fish extends Container {
  private t = 0;
  private dur = 70 + Math.random() * 24;
  private startX: number;
  private dx: number;
  constructor(x: number, private dir: 1 | -1) {
    super();
    const g = new Graphics();
    g.ellipse(0, 0, 7, 4).fill(0xff7e57);
    g.poly([-6, 0, -12, -4, -12, 4]).fill(0xff9b78); // tail
    g.circle(4, -1, 1).fill(0x10131a); // eye
    this.addChild(g);
    this.startX = x;
    this.dx = dir * 38;
    this.scale.x = dir;
  }
  step(dt: number): boolean {
    this.t += dt;
    const p = this.t / this.dur;
    this.x = this.startX + this.dx * p;
    this.y = L.riverY - Math.sin(Math.PI * p) * 46; // arc up and back into the river
    this.rotation = this.dir * (p - 0.5) * 1.7;
    return p < 1;
  }
}
const fishes: Fish[] = [];
function spawnFish() {
  if (!animalConfig.fish) return;
  const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
  const x = 80 + Math.random() * (app.screen.width - 160);
  const fish = new Fish(x, dir);
  fishLayer.addChild(fish);
  fishes.push(fish);
}
setInterval(spawnFish, 5000);
setTimeout(spawnFish, 3000);

// ---------------------------------------------------------------- main loop
drawTown(); // static scene fills the window
window.addEventListener("resize", reflow); // edge-to-edge reflow on resize
setInterval(drawTown, 60_000); // refresh sky as the local time of day changes

app.ticker.add((time) => {
  const dt = time.deltaTime;
  for (const s of sprites.values()) s.tick(dt);
  for (const c of clouds) c.step(dt);
  for (let i = animals.length - 1; i >= 0; i--) {
    if (!animals[i].step(dt)) {
      animals[i].parent?.removeChild(animals[i]);
      animals[i].destroy({ children: true });
      animals.splice(i, 1);
    }
  }
  for (let i = fishes.length - 1; i >= 0; i--) {
    if (!fishes[i].step(dt)) {
      fishes[i].parent?.removeChild(fishes[i]);
      fishes[i].destroy({ children: true });
      fishes.splice(i, 1);
    }
  }
  stepWeather(dt);
  reap(performance.now());
});

// ---------------------------------------------------------------- settings panel
const gear = document.getElementById("gear")!;
const panel = document.getElementById("panel")!;
gear.addEventListener("click", () => panel.classList.toggle("open"));
for (const el of document.querySelectorAll<HTMLInputElement>("input[data-animal]")) {
  el.addEventListener("change", () => {
    animalConfig.enabled[el.dataset.animal as AnimalKind] = el.checked;
  });
}
for (const el of document.querySelectorAll<HTMLInputElement>("input[data-toggle]")) {
  el.addEventListener("change", () => {
    const t = el.dataset.toggle as "fish" | "clouds";
    animalConfig[t] = el.checked;
    if (t === "clouds") cloudLayer.visible = el.checked;
  });
}
const maxEl = document.getElementById("maxAnimals") as HTMLInputElement;
const maxVal = document.getElementById("maxVal")!;
maxEl.addEventListener("input", () => {
  animalConfig.max = Number(maxEl.value);
  maxVal.textContent = maxEl.value;
  // trim immediately if over the new cap
  while (animals.length > animalConfig.max) {
    const a = animals.pop()!;
    a.parent?.removeChild(a);
    a.destroy({ children: true });
  }
});

const townInput = document.getElementById("townName") as HTMLInputElement;
const townGo = document.getElementById("townGo")!;
townInput.value = townName;
updateHud();
const setTown = () => {
  const v = townInput.value.trim();
  townName = v || "Agentville";
  localStorage.setItem("agentville.town", townName);
  updateHud();
  drawTown(); // redraw the welcome sign with the new name
};
townGo.addEventListener("click", setTown);
townInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") setTown();
});

const timeMode = document.getElementById("timeMode") as HTMLSelectElement;
timeMode.addEventListener("change", () => {
  timeOverride = timeMode.value as TimeMode;
  drawTown(); // refresh sky + ambient + lamps for the previewed time
});

const cityInput = document.getElementById("city") as HTMLInputElement;
const cityGo = document.getElementById("cityGo")!;
const wxMode = document.getElementById("wxMode") as HTMLSelectElement;
const wxLabel = document.getElementById("weatherLabel")!;

const refreshAuto = () => {
  const v = cityInput.value.trim();
  if (v) void applyCity(v);
  else wxLabel.textContent = "Weather: enter a city for auto mode";
};
const onModeChange = () => {
  const m = wxMode.value;
  if (m === "auto") {
    refreshAuto();
  } else {
    setWeather(m as WeatherKind); // manual override — see any effect on demand
    wxLabel.textContent = `Manual: ${WX_TEXT[m as WeatherKind]}`;
  }
};
wxMode.addEventListener("change", onModeChange);

const submitCity = () => {
  wxMode.value = "auto";
  refreshAuto();
};
cityGo.addEventListener("click", submitCity);
cityInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitCity();
});

const savedCity = localStorage.getItem("agentville.city");
if (savedCity) {
  cityInput.value = savedCity;
  refreshAuto();
}
setInterval(() => {
  if (wxMode.value === "auto") refreshAuto(); // keep current weather fresh
}, 15 * 60 * 1000);

window.agentville.onSessionInfo((info) => {
  projectName = info?.projectName ?? "";
  updateHud();
});
window.agentville.onAgentDiff((changes) => {
  for (const c of changes) applyChange(c);
});

const snap = await window.agentville.getSnapshot();
for (const a of snap) ensureSprite({ agentId: a.agentId, kind: a.kind, type: a.type }).update(a.state, a.task, a.type);
retarget();
