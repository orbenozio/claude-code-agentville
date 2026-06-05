import { Application, Container, Graphics, Text } from "pixi.js";
import type { AgentState, AgentVisualState } from "../core/types.js";
import type { StateChange } from "../core/Reducer.js";

// ---- bridge typing (exposed by preload) ----
interface SessionInfo {
  projectDir: string;
  sessionId: string;
}
interface AgentvilleApi {
  onAgentDiff(cb: (changes: StateChange[]) => void): void;
  onSessionInfo(cb: (info: SessionInfo | null) => void): void;
  getSnapshot(): Promise<AgentState[]>;
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

const app = new Application();
await app.init({ resizeTo: window, background: 0x7ec850, antialias: true });
document.getElementById("app")!.appendChild(app.canvas);

// ---------------------------------------------------------------- layout
interface Layout {
  skyH: number;
  riverY: number;
  homeY: number;
  homeStartX: number;
  homeGapX: number;
  mayor: { x: number; y: number };
  roadY: number;
  factory: { x: number; y: number };
  factoryFloor: { x: number; y: number; w: number; h: number };
}
function computeLayout(): Layout {
  const W = app.screen.width;
  const H = app.screen.height;
  const roadY = H - 120;
  const factory = { x: W - 150, y: roadY - 70 };
  return {
    skyH: 100,
    riverY: 140,
    homeY: 232,
    homeStartX: 250,
    homeGapX: 150,
    mayor: { x: 110, y: 242 },
    roadY,
    factory,
    factoryFloor: { x: factory.x - 95, y: factory.y - 20, w: 150, h: 90 },
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
app.stage.addChild(bgStatic, cloudLayer, fishLayer, pathLayer, groundAnimalLayer, structStatic, houseWallLayer, agentLayer, roofLayer, skyLayer);

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

function drawTown() {
  bgStatic.removeChildren();
  structStatic.removeChildren();
  L = computeLayout();
  const W = app.screen.width;
  const H = app.screen.height;

  // sky band at the top, grass fills the rest (canvas bg is already grass-green)
  const sky = new Graphics();
  sky.rect(0, 0, W, L.skyH + 30).fill(0xbfe7ff);
  sky.rect(0, L.skyH + 22, W, 10).fill(0xa9d66b); // soft horizon blend
  bgStatic.addChild(sky);

  // winding river just under the sky
  const river = new Graphics();
  const ry = L.riverY;
  river.moveTo(0, ry - 16);
  for (let x = 0; x <= W; x += 60) river.quadraticCurveTo(x + 30, ry - 16 + (x % 120 ? 10 : -10), x + 60, ry - 16);
  river.lineTo(W, ry + 18);
  for (let x = W; x >= 0; x -= 60) river.quadraticCurveTo(x - 30, ry + 18 + (x % 120 ? -8 : 10), x - 60, ry + 18);
  river.closePath().fill(0x4aa3df);
  for (let x = 20; x < W; x += 70) river.ellipse(x, ry, 10, 2.2).fill(0x8fd0f2); // ripples
  bgStatic.addChild(river);

  // scattered flowers on the meadow (below the river)
  const flowers = new Graphics();
  for (let i = 0; i < 36; i++) {
    const x = (i * 137.5) % W;
    const y = L.riverY + 60 + ((i * 89.3) % (H - L.riverY - 160));
    flowers.circle(x, y, 2.5).fill([0xffffff, 0xfff066, 0xff9ff3][i % 3]);
  }
  bgStatic.addChild(flowers);

  const road = new Graphics();
  road.roundRect(40, L.roadY - 16, W - 80, 32, 16).fill(0xcaa472).stroke({ width: 2, color: 0xb08e5e });
  for (let x = 70; x < W - 60; x += 46) road.rect(x, L.roadY - 2, 22, 4).fill(0xead9b8);
  bgStatic.addChild(road);

  // factory (structure)
  const f = new Graphics();
  const { x: fx, y: fy } = L.factory;
  f.roundRect(fx - 100, fy - 60, 200, 150, 8).fill(0x9aa0aa);
  f.rect(fx - 100, fy - 60, 200, 22).fill(0x767d88);
  f.rect(fx + 56, fy - 96, 22, 46).fill(0x767d88);
  f.rect(fx + 22, fy - 86, 20, 36).fill(0x767d88);
  f.roundRect(fx - 18, fy + 40, 40, 50, 3).fill(0x555b64);
  for (let i = 0; i < 3; i++) f.roundRect(fx - 80 + i * 46, fy - 20, 32, 30, 3).fill(0xbfe3ff);
  structStatic.addChild(f);
  const fl = new Text({ text: "FACTORY", style: { fontFamily: "Segoe UI", fontSize: 13, fontWeight: "800", fill: 0xffffff } });
  fl.anchor.set(0.5);
  fl.position.set(fx, fy - 47);
  structStatic.addChild(fl);

  // fruit trees scattered in the meadow (apple / plum / orange)
  const treeY = H - 150;
  structStatic.addChild(fruitTree(150, treeY, 0xe63946)); // apple
  structStatic.addChild(fruitTree(W - 320, treeY, 0xb5179e)); // plum
  structStatic.addChild(fruitTree(W * 0.5, treeY + 24, 0xff8c1a)); // orange
}

function colorForSlot(slot: number): number {
  return PALETTE[slot % PALETTE.length];
}

// ---------------------------------------------------------------- house (path + walls + roof)
interface House {
  path: Graphics; // ground plane
  walls: Container; // structure
  roof: Container; // front
}
function buildHouse(x: number, y: number, color: number, isMayor: boolean): House {
  const w = isMayor ? 92 : 72;
  const h = isMayor ? 64 : 52;

  const path = new Graphics();
  path.roundRect(x - 9, y + h / 2 - 6, 18, L.roadY - (y + h / 2) + 10, 9).fill(0xcaa472);

  const walls = new Container();
  const g = new Graphics();
  g.roundRect(x - w / 2, y - h / 2, w, h, 5).fill(0xf3ead6).stroke({ width: 2, color: 0x00000018 });
  g.roundRect(x - 15, y - 6, 30, h / 2 + 6, 4).fill(0x4a3b2a); // doorway
  g.roundRect(x + w / 2 - 24, y - h / 2 + 10, 14, 14, 2).fill(0xbfe3ff); // window
  walls.addChild(g);
  if (isMayor) {
    const lbl = new Text({ text: "TOWN HALL", style: { fontFamily: "Segoe UI", fontSize: 10, fontWeight: "800", fill: 0x5a3d1a } });
    lbl.anchor.set(0.5);
    lbl.position.set(x, y + h / 2 + 9);
    walls.addChild(lbl);
  }

  const roof = new Container();
  const r = new Graphics();
  r.poly([x - w / 2 - 6, y - h / 2 + 2, x, y - h / 2 - 26, x + w / 2 + 6, y - h / 2 + 2]).fill(color).stroke({ width: 2, color: 0x00000022 });
  if (isMayor) {
    r.rect(x - 1, y - h / 2 - 52, 2, 26).fill(0x6b4423);
    r.poly([x + 1, y - h / 2 - 52, x + 24, y - h / 2 - 45, x + 1, y - h / 2 - 38]).fill(0xe63946);
  }
  roof.addChild(r);
  return { path, walls, roof };
}

// ---------------------------------------------------------------- agent sprite
class AgentSprite extends Container {
  private inner = new Container();
  private body = new Graphics();
  private hat = new Graphics();
  private face = new Graphics();
  private badge = new Text({ text: "", style: { fontSize: 18 } });
  private nameLabel: Text;
  private bubble = new Container();
  private bubbleText: Text;
  private zzz: { t: Text; vy: number; life: number }[] = [];
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

  constructor(public agentId: string, public kind: "main" | "subagent", typeName: string | undefined, slot: number) {
    super();
    this.slot = slot;
    this.color = kind === "main" ? MAYOR_COLOR : colorForSlot(slot);

    this.nameLabel = new Text({
      text: kind === "main" ? "🎩 Mayor" : typeName ?? "agent",
      style: { fontFamily: "Segoe UI", fontSize: 12, fontWeight: "700", fill: 0x12330f },
    });
    this.nameLabel.anchor.set(0.5);
    this.nameLabel.y = 30;

    this.badge.anchor.set(0.5);
    this.badge.y = -34;

    this.bubbleText = new Text({
      text: "",
      style: { fontFamily: "Segoe UI", fontSize: 12, fontWeight: "600", fill: 0x333333, wordWrap: true, wordWrapWidth: 150, align: "center" },
    });
    this.bubble.visible = false;

    this.inner.addChild(this.body, this.hat, this.face);
    this.addChild(this.inner, this.badge, this.nameLabel, this.bubble);
    this.redraw();
  }

  attachHouse(house: House) {
    this.house = house;
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
    } else if (working) {
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
    if (typeName && this.kind === "subagent") this.nameLabel.text = typeName;
    const showBubble = state === "working" && !!task;
    this.bubble.visible = showBubble;
    if (showBubble) this.drawThought(shortTask(task!));
    if (was !== state) this.redraw();
    if (state === "working" && was !== "working") this.wanderTarget = undefined;
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
    } else {
      this.inner.y = 0;
      this.inner.rotation = 0;
      this.inner.scale.y = 1;
    }

    if (this.state === "working" && !moving) {
      this.wanderClock += dt;
      if (!this.wanderTarget || this.wanderClock > 90) {
        this.wanderClock = 0;
        const z = L.factoryFloor;
        this.wanderTarget = { x: z.x + Math.random() * z.w, y: z.y + Math.random() * z.h };
      }
    } else if (this.state !== "working") {
      this.wanderTarget = undefined;
    }

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

function homePos(slot: number): { x: number; y: number } {
  return { x: L.homeStartX + slot * L.homeGapX, y: L.homeY };
}

function ensureSprite(s: { agentId: string; kind: "main" | "subagent"; type?: string }): AgentSprite {
  let sp = sprites.get(s.agentId);
  if (!sp) {
    const slot = s.kind === "main" ? -1 : allocSlot();
    sp = new AgentSprite(s.agentId, s.kind, s.type, slot);
    sprites.set(s.agentId, sp);
    agentLayer.addChild(sp);

    const pos = s.kind === "main" ? L.mayor : homePos(slot);
    const house = buildHouse(pos.x, pos.y, sp.color, s.kind === "main");
    sp.attachHouse(house);
    pathLayer.addChild(house.path);
    houseWallLayer.addChild(house.walls);
    roofLayer.addChild(house.roof);
    sp.setHome(pos.x, pos.y + (s.kind === "main" ? 34 : 28));
    sp.position.set(sp.home.x, sp.home.y);
  }
  return sp;
}

function retarget() {
  L = computeLayout();
  const atFactory = [...sprites.values()].filter(
    (s) => s.state === "working" || s.state === "error" || s.state === "rateLimited",
  );
  atFactory.forEach((s, i) => {
    const z = L.factoryFloor;
    s.target = { x: z.x + 20 + (i % 3) * 50, y: z.y + 20 + Math.floor(i / 3) * 40 };
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

const DONE_VANISH_MS = 5 * 60 * 1000; // SPEC ש3
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

    // ground animals sometimes stop to graze/peck together in the meadow
    if (kind !== "bird" && Math.random() < 0.6) {
      this.mode = "toGraze";
      const gx = 150 + Math.random() * 260; // gather toward the left meadow
      const gy = app.screen.height - 185 + Math.random() * 30;
      this.grazeAt = { x: gx, y: gy };
    }
  }

  private face(d: number) {
    this.scale.x = d >= 0 ? 1 : -1;
  }

  step(dt: number): boolean {
    if (this.kind === "bird") {
      this.flap += dt * 0.3;
      this.y = this.baseY + Math.sin(this.flap) * 4; // gentle bobbing flight
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

const animals: Animal[] = [];
function spawnAnimal() {
  if (animals.length > 8) return;
  const kind: AnimalKind = Math.random() < 0.3 ? "bird" : GROUND_KINDS[Math.floor(Math.random() * GROUND_KINDS.length)];
  const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
  const y = kind === "bird" ? 40 + Math.random() * 80 : app.screen.height - 185 - Math.random() * 35;
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
  const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
  const x = 80 + Math.random() * (app.screen.width - 160);
  const fish = new Fish(x, dir);
  fishLayer.addChild(fish);
  fishes.push(fish);
}
setInterval(spawnFish, 5000);
setTimeout(spawnFish, 3000);

// ---------------------------------------------------------------- main loop
drawTown();
window.addEventListener("resize", () => {
  drawTown();
  retarget();
});

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
  reap(performance.now());
});

window.agentville.onSessionInfo((info) => {
  hud.textContent = info ? `Agentville 🏘️ — ${info.projectDir}` : "Agentville 🏘️ — no active session";
});
window.agentville.onAgentDiff((changes) => {
  for (const c of changes) applyChange(c);
});

const snap = await window.agentville.getSnapshot();
for (const a of snap) ensureSprite({ agentId: a.agentId, kind: a.kind, type: a.type }).update(a.state, a.task, a.type);
retarget();
