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
  idle: "💤",
  working: "🏭",
  done: "✅",
  error: "⚠️",
  rateLimited: "😴",
};

const hud = document.getElementById("hud")!;

const app = new Application();
await app.init({ resizeTo: window, background: 0x7ec850, antialias: true });
document.getElementById("app")!.appendChild(app.canvas);

// ---------------------------------------------------------------- town layout
const world = new Container();
app.stage.addChild(world);

function layout() {
  return {
    factory: { x: app.screen.width - 230, y: app.screen.height / 2 - 40 },
    homesX: 90,
    homesTop: 110,
    homeGapY: 96,
    plaza: { x: app.screen.width / 2 - 40, y: app.screen.height - 150 },
  };
}

const ground = new Container();
world.addChild(ground);

function drawTown() {
  ground.removeChildren();
  const L = layout();

  // dirt path from homes to factory
  const path = new Graphics();
  path
    .moveTo(L.homesX + 40, app.screen.height / 2)
    .lineTo(L.factory.x, L.factory.y + 60)
    .stroke({ width: 46, color: 0xcBA86a, alpha: 0.55, cap: "round" });
  ground.addChild(path);

  // factory
  const f = new Graphics();
  f.roundRect(L.factory.x - 70, L.factory.y - 70, 200, 170, 10).fill(0x8a8f98);
  f.rect(L.factory.x - 70, L.factory.y - 70, 200, 26).fill(0x6f7682);
  // chimneys
  f.rect(L.factory.x + 70, L.factory.y - 110, 24, 50).fill(0x6f7682);
  f.rect(L.factory.x + 30, L.factory.y - 100, 22, 40).fill(0x6f7682);
  // door + windows
  f.roundRect(L.factory.x + 10, L.factory.y + 40, 40, 60, 4).fill(0x4a4f57);
  for (let i = 0; i < 3; i++) f.roundRect(L.factory.x - 55 + i * 45, L.factory.y - 30, 30, 30, 3).fill(0xbfe3ff);
  const fl = new Text({ text: "FACTORY", style: { fontFamily: "Segoe UI", fontSize: 14, fontWeight: "700", fill: 0xffffff } });
  fl.x = L.factory.x - 36;
  fl.y = L.factory.y - 64;
  ground.addChild(f, fl);

  // a few decorative trees
  for (const [tx, ty] of [[260, 80], [380, app.screen.height - 70], [620, 120], [700, app.screen.height - 90]] as const) {
    const t = new Graphics();
    t.rect(tx - 4, ty, 8, 18).fill(0x7a5230);
    t.circle(tx, ty - 6, 18).fill(0x4ea24e);
    ground.addChild(t);
  }
}

// home drawn per agent slot
function drawHome(x: number, y: number, color: number): Graphics {
  const h = new Graphics();
  h.roundRect(x - 34, y - 26, 68, 52, 6).fill(0xf3ede0);
  h.poly([x - 40, y - 26, x, y - 56, x + 40, y - 26]).fill(color);
  h.roundRect(x - 10, y - 6, 20, 32, 3).fill(0x9a6b3f);
  return h;
}

// ---------------------------------------------------------------- agent sprite
function colorFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return hslToHex(hue, 65, 55);
}
function hslToHex(h: number, s: number, l: number): number {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) => Math.round(255 * x);
  return (to(f(0)) << 16) | (to(f(8)) << 8) | to(f(4));
}

class AgentSprite extends Container {
  private body = new Graphics();
  private face = new Graphics();
  private badge = new Text({ text: "", style: { fontSize: 20 } });
  private nameLabel: Text;
  private bubble = new Container();
  private bubbleText: Text;
  private homeG: Graphics;
  target = { x: 0, y: 0 };
  home = { x: 0, y: 0 };
  state: AgentVisualState = "working";
  readonly color: number;
  bob = Math.random() * Math.PI * 2;
  slot = -1; // home slot index (subagents), for recycling
  doneAt = 0; // performance.now() when it reached "done"

  constructor(public agentId: string, public kind: "main" | "subagent", typeName: string | undefined) {
    super();
    this.color = kind === "main" ? 0xffd23f : colorFor(agentId);
    this.homeG = drawHome(0, 0, this.color);
    this.homeG.visible = kind !== "main";

    this.nameLabel = new Text({
      text: kind === "main" ? "main" : typeName ?? "agent",
      style: { fontFamily: "Segoe UI", fontSize: 12, fontWeight: "700", fill: 0x12330f },
    });
    this.nameLabel.anchor.set(0.5);
    this.nameLabel.y = 30;

    this.badge.anchor.set(0.5);
    this.badge.y = -34;

    this.bubbleText = new Text({ text: "", style: { fontFamily: "Segoe UI", fontSize: 12, fill: 0x222222, wordWrap: true, wordWrapWidth: 180 } });
    this.bubble.y = -58;
    this.bubble.visible = false;

    this.addChild(this.body, this.face, this.badge, this.nameLabel, this.bubble);
    this.redrawBody();
  }

  private redrawBody() {
    const r = this.kind === "main" ? 20 : 16;
    this.body.clear().roundRect(-r, -r, r * 2, r * 2, 6).fill(this.color).stroke({ width: 2, color: 0x00000022 });
    // simple face
    this.face.clear();
    const eyeY = -4;
    if (this.state === "idle" || this.state === "rateLimited") {
      this.face.moveTo(-7, eyeY).lineTo(-2, eyeY).moveTo(2, eyeY).lineTo(7, eyeY).stroke({ width: 2, color: 0x222222 });
    } else {
      this.face.circle(-5, eyeY, 2).circle(5, eyeY, 2).fill(0x222222);
    }
    const mouthY = 6;
    if (this.state === "error") this.face.moveTo(-5, mouthY + 2).lineTo(5, mouthY - 2).stroke({ width: 2, color: 0x222222 });
    else this.face.moveTo(-5, mouthY).lineTo(5, mouthY).stroke({ width: 2, color: 0x222222 });
  }

  setHome(x: number, y: number) {
    this.home = { x, y };
    this.homeG.x = x;
    this.homeG.y = y - 2;
  }

  homeLayer(): Graphics {
    return this.homeG;
  }

  update(state: AgentVisualState, task: string | undefined, typeName: string | undefined) {
    this.state = state;
    if (state === "done" && this.doneAt === 0) this.doneAt = performance.now();
    this.badge.text = STATE_BADGE[state];
    if (typeName && this.kind === "subagent") this.nameLabel.text = typeName;
    const showBubble = state === "working" && !!task;
    this.bubble.visible = showBubble;
    if (showBubble) this.drawBubble(task!);
    this.redrawBody();
  }

  private drawBubble(task: string) {
    this.bubble.removeChildren();
    this.bubbleText.text = task.length > 90 ? task.slice(0, 89) + "…" : task;
    const w = Math.min(196, this.bubbleText.width + 16);
    const h = this.bubbleText.height + 12;
    const bg = new Graphics();
    bg.roundRect(-w / 2, -h, w, h, 8).fill(0xffffff).stroke({ width: 1, color: 0x00000022 });
    bg.poly([-6, -2, 6, -2, 0, 8]).fill(0xffffff);
    this.bubbleText.x = -w / 2 + 8;
    this.bubbleText.y = -h + 6;
    this.bubble.addChild(bg, this.bubbleText);
  }

  tick(dt: number) {
    // ease toward target
    this.x += (this.target.x - this.x) * Math.min(1, dt * 0.12);
    this.y += (this.target.y - this.y) * Math.min(1, dt * 0.12);
    // gentle bob when sleeping
    if (this.state === "idle" || this.state === "rateLimited") {
      this.bob += dt * 0.06;
      this.body.y = Math.sin(this.bob) * 1.5;
    } else {
      this.body.y = 0;
    }
  }
}

// ---------------------------------------------------------------- scene state
const sprites = new Map<string, AgentSprite>();
const homeLayer = new Container();
const agentLayer = new Container();
world.addChild(homeLayer, agentLayer);

let nextHomeSlot = 0;
const freeSlots: number[] = [];
const allocSlot = () => (freeSlots.length ? freeSlots.shift()! : nextHomeSlot++);

function ensureSprite(s: { agentId: string; kind: "main" | "subagent"; type?: string }): AgentSprite {
  let sp = sprites.get(s.agentId);
  if (!sp) {
    sp = new AgentSprite(s.agentId, s.kind, s.type);
    sprites.set(s.agentId, sp);
    agentLayer.addChild(sp);
    homeLayer.addChild(sp.homeLayer());
    const L = layout();
    if (s.kind === "main") {
      sp.setHome(L.plaza.x, L.plaza.y);
      sp.x = L.plaza.x;
      sp.y = L.plaza.y;
    } else {
      sp.slot = allocSlot();
      const col = Math.floor(sp.slot / 5);
      const row = sp.slot % 5;
      sp.setHome(L.homesX + col * 92, L.homesTop + row * L.homeGapY);
      sp.x = sp.home.x;
      sp.y = sp.home.y + 40;
    }
  }
  return sp;
}

const DONE_VANISH_MS = 5 * 60 * 1000; // SPEC ש3

function reap(now: number) {
  for (const [id, s] of sprites) {
    if (s.state === "done" && s.doneAt > 0 && now - s.doneAt > DONE_VANISH_MS) {
      agentLayer.removeChild(s);
      homeLayer.removeChild(s.homeLayer());
      s.homeLayer().destroy();
      s.destroy({ children: true });
      if (s.slot >= 0) freeSlots.push(s.slot);
      sprites.delete(id);
    }
  }
}

function retarget() {
  const L = layout();
  // pack the "at factory" agents into a tidy grid near the factory
  const atFactory = [...sprites.values()].filter((s) => s.state === "working" || s.state === "error" || s.state === "rateLimited");
  atFactory.forEach((s, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    s.target = { x: L.factory.x - 30 + col * 46, y: L.factory.y + 120 + row * 52 };
  });
  for (const s of sprites.values()) {
    if (s.kind === "main") {
      s.target = { x: L.plaza.x, y: L.plaza.y };
    } else if (s.state === "idle" || s.state === "done") {
      s.target = { x: s.home.x, y: s.home.y + 38 };
    }
  }
}

function applyChange(c: StateChange) {
  const sp = ensureSprite({ agentId: c.agentId, kind: c.state.kind, type: c.state.type });
  sp.update(c.after, c.state.task, c.state.type);
  retarget();
}

// ---------------------------------------------------------------- wire it up
drawTown();
window.addEventListener("resize", () => {
  drawTown();
  retarget();
});

app.ticker.add((time) => {
  for (const s of sprites.values()) s.tick(time.deltaTime);
  reap(performance.now());
});

window.agentville.onSessionInfo((info) => {
  hud.textContent = info ? `Agentville 🏘️ — ${info.projectDir}` : "Agentville 🏘️ — no active session";
});
window.agentville.onAgentDiff((changes) => {
  for (const c of changes) applyChange(c);
});

// initial snapshot (in case diffs were emitted before we subscribed)
const snap = await window.agentville.getSnapshot();
for (const a of snap) {
  const sp = ensureSprite({ agentId: a.agentId, kind: a.kind, type: a.type });
  sp.update(a.state, a.task, a.type);
}
retarget();
