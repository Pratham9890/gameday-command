import { Application, Container, Graphics, Matrix, Sprite, Texture } from 'pixi.js';
import type { CellKind, FanType, MapBundle } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_STATES } from '../../contracts.ts';
import { isoProject, isoUnproject, rgbNum, shirtColor, skinOf, STATE_RGB } from './people.ts';

/**
 * The close-up: one run on an isometric map you can zoom into until the dots
 * become people. Inspired by the operator view in Cryplo/MHacks26.
 *
 * Imperative on purpose, like ComparisonMaps: React pushes frames and the
 * selection in, and PixiJS draws on its own ticker. World units are meters on
 * the isometric plane (see `isoProject`), and one camera transform maps them to
 * screen pixels.
 *
 * Level of detail is what makes 20,000 dots affordable. Zoomed out, the crowd is
 * one 800x800 texture of coloured cells, the same trick as the side-by-side
 * maps. Zoomed in past PEOPLE_MIN_SCALE, only the groups inside the viewport get
 * a pooled figure, capped at MAX_PEOPLE, so the cost follows what is on screen
 * rather than the size of the crowd.
 */

/** Screen pixels per world meter at which dots become people. */
export const PEOPLE_MIN_SCALE = 3.5;
const MAX_SCALE = 32;
const MAX_PEOPLE = 2500;
/** Texture pixels per world meter for the figure parts. */
const RES = 40;
/** Figures are drawn larger than life: one dot is five fans, and a true-scale person is a speck. */
const LEG_H = 0.95;
const TORSO_H = 0.95;
const HEAD_R = 0.34;
const FIG_H = LEG_H + TORSO_H + HEAD_R * 2;
/** Frames further apart than this are a jump (arrival, rewind), not a walk. */
const MAX_TWEEN_M = 30;

const GROUND: Record<CellKind, [number, number, number]> = {
  blocked: [0x2a, 0x2d, 0x33],
  walk: [0x3c, 0x55, 0x36],
  road: [0x4a, 0x4d, 0x53],
  stands: [0x8c, 0x2c, 0x2e],
  concourse: [0x6c, 0x6f, 0x76],
  shelter: [0x4e, 0x6b, 0x5c],
  parking: [0x3c, 0x3f, 0x46],
};
const ROOFS = [0x8c939c, 0x9a8f86, 0x7d8a94, 0xa39a8c, 0x88827a, 0x947f74];
const LEGS = 0x2b3a55;
const OFFICER = 0x58a6ff;

const hash = (n: number) => {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};

const shade = (color: number, k: number) => {
  const r = Math.min(255, ((color >> 16) & 255) * k);
  const g = Math.min(255, ((color >> 8) & 255) * k);
  const b = Math.min(255, (color & 255) * k);
  return ((r | 0) << 16) | ((g | 0) << 8) | (b | 0);
};

export interface SceneFrame {
  t: number;
  x: Float32Array;
  y: Float32Array;
  state: Uint8Array;
  officerCells: Int32Array;
  density?: Float32Array;
}

export interface CrowdSceneInit {
  host: HTMLElement;
  overlay: HTMLElement;
  map: MapBundle;
  types: FanType[];
  dangerDensity: number;
  onPick: (dot: number | null) => void;
  onFollowChange: (following: boolean) => void;
}

interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: ImageData;
  texture: Texture;
  sprite: Sprite;
}

interface Person {
  c: Container;
  ring: Sprite;
  legs: Sprite;
  torso: Sprite;
  head: Sprite;
}

interface Parts {
  shadow: Texture;
  ring: Texture;
  legs: Texture[];
  torso: Texture;
  head: Texture;
}

function makeLayer(width: number, height: number): Layer {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  return { canvas, ctx, image, texture, sprite: new Sprite(texture) };
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!);
  return Texture.from(canvas);
}

/** White figure parts, tinted per group, so the whole crowd shares five textures. */
function makeParts(): Parts {
  const legW = Math.round(0.9 * RES);
  const legH = Math.round(LEG_H * RES);
  const legs = [0, 1, -1].map((stride) =>
    canvasTexture(legW, legH, (g) => {
      g.fillStyle = '#fff';
      const w = 0.3 * RES;
      g.beginPath();
      g.roundRect(legW / 2 - w - 1.5 + stride * 6, 0, w, legH, 5);
      g.roundRect(legW / 2 + 1.5 - stride * 6, 0, w, legH, 5);
      g.fill();
    }),
  );
  const torsoW = Math.round(1.05 * RES);
  const torsoH = Math.round(TORSO_H * RES);
  const torso = canvasTexture(torsoW, torsoH, (g) => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.roundRect(torsoW * 0.12, 0, torsoW * 0.76, torsoH, [12, 12, 5, 5]);
    g.fill();
    // arms
    g.fillStyle = 'rgba(255,255,255,0.82)';
    g.beginPath();
    g.roundRect(0, torsoH * 0.08, torsoW * 0.16, torsoH * 0.8, 5);
    g.roundRect(torsoW * 0.84, torsoH * 0.08, torsoW * 0.16, torsoH * 0.8, 5);
    g.fill();
  });
  const headD = Math.round(HEAD_R * 2 * RES);
  const head = canvasTexture(headD, headD, (g) => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(headD / 2, headD / 2, headD / 2, 0, Math.PI * 2);
    g.fill();
  });
  const ringW = Math.round(1.7 * RES);
  const ringH = Math.round(0.85 * RES);
  const ring = canvasTexture(ringW, ringH, (g) => {
    g.strokeStyle = '#fff';
    g.lineWidth = 5;
    g.beginPath();
    g.ellipse(ringW / 2, ringH / 2, ringW / 2 - 4, ringH / 2 - 4, 0, 0, Math.PI * 2);
    g.stroke();
  });
  const shadow = canvasTexture(ringW, ringH, (g) => {
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.beginPath();
    g.ellipse(ringW / 2, ringH / 2, ringW / 2 - 8, ringH / 2 - 6, 0, 0, Math.PI * 2);
    g.fill();
  });
  return { shadow, ring, legs, torso, head };
}

/** The static ground as pixel bytes, with a little per-cell grain so open ground does not read as flat paint. */
function paintGround(map: MapBundle): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = map.width;
  canvas.height = map.height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(map.width, map.height);
  const data = image.data;
  for (let i = 0; i < map.cells.length; i++) {
    const [r, g, b] = GROUND[map.cells[i]!];
    const grain = 0.92 + (hash(i) % 1000) / 6250;
    const o = i * 4;
    data[o] = Math.min(255, r * grain);
    data[o + 1] = Math.min(255, g * grain);
    data[o + 2] = Math.min(255, b * grain);
    data[o + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Buildings as extruded polygons: a roof per short run of blocked cells and a
 * wall wherever a blocked cell faces open ground to the south or east, which
 * are the two faces this viewpoint can see. Height and roof colour come from
 * the connected building, so neighbouring blocks read as separate buildings;
 * thin pieces (walls, fences) stay low.
 *
 * Drawn painter's-order by depth (x + y). Runs are kept short because a long
 * run sorted by one key would paint over a building standing in front of it.
 */
function buildBuildings(map: MapBundle): Graphics {
  const { width, height, cells } = map;
  const blocked = (u: number, v: number) => u >= 0 && v >= 0 && u < width && v < height && cells[v * width + u] === 'blocked';

  const label = new Int32Array(width * height).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < cells.length; start++) {
    if (cells[start] !== 'blocked' || label[start]! >= 0) continue;
    const id = sizes.length;
    let size = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const cell = stack.pop()!;
      size++;
      const u = cell % width;
      const v = (cell / width) | 0;
      for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (!blocked(u + du, v + dv)) continue;
        const next = (v + dv) * width + u + du;
        if (label[next]! >= 0) continue;
        label[next] = id;
        stack.push(next);
      }
    }
    sizes.push(size);
  }
  const heightOf = (id: number) => (sizes[id]! < 40 ? 2.5 : 7 + (hash(id) % 5) * 3);
  const roofOf = (id: number) => ROOFS[hash(id + 101) % ROOFS.length]!;

  type Item = { key: number; points: number[]; color: number };
  const items: Item[] = [];
  const C = CELL_SIZE_M;
  const quad = (pts: [number, number, number][]) =>
    pts.flatMap(([mx, my, h]) => {
      const p = isoProject(mx, my, h);
      return [p.sx, p.sy];
    });

  const MAX_RUN = 6;
  for (let v = 0; v < height; v++) {
    let u = 0;
    while (u < width) {
      const id = label[v * width + u]!;
      if (id < 0) {
        u++;
        continue;
      }
      let end = u;
      while (end + 1 < width && end - u + 1 < MAX_RUN && label[v * width + end + 1] === id) end++;
      const h = heightOf(id);
      const roof = roofOf(id);
      const x0 = u * C;
      const x1 = (end + 1) * C;
      const y0 = v * C;
      const y1 = (v + 1) * C;

      // South wall, split where open ground below starts and stops.
      let s = u;
      while (s <= end) {
        if (blocked(s, v + 1)) {
          s++;
          continue;
        }
        let e = s;
        while (e + 1 <= end && !blocked(e + 1, v + 1)) e++;
        items.push({
          key: (e + v) * 4,
          color: shade(roof, 0.58),
          points: quad([[s * C, y1, 0], [(e + 1) * C, y1, 0], [(e + 1) * C, y1, h], [s * C, y1, h]]),
        });
        s = e + 1;
      }
      // East wall at the run's end.
      if (!blocked(end + 1, v)) {
        items.push({
          key: (end + v) * 4 + 1,
          color: shade(roof, 0.76),
          points: quad([[x1, y0, 0], [x1, y1, 0], [x1, y1, h], [x1, y0, h]]),
        });
      }
      items.push({ key: (end + v) * 4 + 2, color: roof, points: quad([[x0, y0, h], [x1, y0, h], [x1, y1, h], [x0, y1, h]]) });
      u = end + 1;
    }
  }
  items.sort((a, b) => a.key - b.key);

  const g = new Graphics();
  for (const item of items) g.poly(item.points, true).fill(item.color);
  return g;
}

export class CrowdScene {
  private readonly init: CrowdSceneInit;
  private app: Application | null = null;
  private ready: Promise<void>;
  private destroyed = false;

  private world = new Container();
  private ground = new Container();
  private people = new Container();
  private officers = new Graphics();
  private marker = new Graphics();
  private zone = new Graphics();
  private heat!: Layer;
  private dots!: Layer;
  private parts!: Parts;
  private pool: Person[] = [];
  private labels: { el: HTMLElement; sx: number; sy: number; gate: boolean }[] = [];
  private nameTag: HTMLElement;

  private cam = { scale: 1, x: 0, y: 0 };
  private fitScale = 1;
  private follow = false;
  private selected: number | null = null;
  /** A focus asked for before the canvas existed, applied once it does. */
  private pendingFocus: number | null = null;

  private prev: SceneFrame | null = null;
  private cur: SceneFrame | null = null;
  private arrivedAt = 0;
  private interval = 750;
  private tween = true;
  private typeIndex: Uint16Array | null = null;
  private showHeat = true;

  private cleanup: (() => void)[] = [];

  constructor(init: CrowdSceneInit) {
    this.init = init;
    this.nameTag = document.createElement('div');
    this.nameTag.className = 'crowd-name';
    this.nameTag.style.display = 'none';
    init.overlay.appendChild(this.nameTag);
    this.ready = this.start();
  }

  private async start(): Promise<void> {
    const { host, map } = this.init;
    const app = new Application();
    await app.init({
      resizeTo: host,
      background: 0x0b0f14,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
    });
    if (this.destroyed) {
      app.destroy(true);
      return;
    }
    this.app = app;
    host.appendChild(app.canvas);
    app.canvas.style.display = 'block';

    this.parts = makeParts();
    const W = map.width * CELL_SIZE_M;
    const H = map.height * CELL_SIZE_M;

    // A slab under the map, so it reads as a model on a table.
    const slab = new Graphics();
    const depth = 24;
    const left = isoProject(0, H);
    const bottom = isoProject(W, H);
    const right = isoProject(W, 0);
    slab.poly([left.sx, left.sy, bottom.sx, bottom.sy, bottom.sx, bottom.sy + depth, left.sx, left.sy + depth]).fill(0x2a2620);
    slab.poly([bottom.sx, bottom.sy, right.sx, right.sy, right.sx, right.sy + depth, bottom.sx, bottom.sy + depth]).fill(0x3a342b);

    // Cell space -> isometric meters, as one matrix: cell (u, v) is meters
    // (2u, 2v), and isoProject is linear.
    this.ground.setFromMatrix(new Matrix(CELL_SIZE_M, CELL_SIZE_M / 2, -CELL_SIZE_M, CELL_SIZE_M / 2, 0, 0));
    const baseTexture = Texture.from(paintGround(map));
    baseTexture.source.scaleMode = 'nearest';
    this.heat = makeLayer(map.width, map.height);
    this.heat.sprite.alpha = 0.8;
    this.dots = makeLayer(map.width, map.height);
    this.ground.addChild(new Sprite(baseTexture), this.heat.sprite, this.zone, this.dots.sprite);

    this.people.sortableChildren = true;
    this.world.addChild(slab, this.ground, buildBuildings(map), this.people, this.officers, this.marker);
    app.stage.addChild(this.world);

    this.makeLabels();
    this.bindInput(app.canvas);
    this.fit();
    if (this.pendingFocus !== null) this.focus(this.pendingFocus);
    this.pendingFocus = null;
    app.ticker.add(() => this.tick());
  }

  private makeLabels(): void {
    const { map, overlay } = this.init;
    for (const place of map.places) {
      const gate = place.kind === 'gate';
      if (!gate && place.kind !== 'seating') continue;
      let sx = 0;
      let sy = 0;
      for (const cell of place.cells) {
        sx += (cell % map.width) + 0.5;
        sy += Math.floor(cell / map.width) + 0.5;
      }
      const n = Math.max(1, place.cells.length);
      const p = isoProject((sx / n) * CELL_SIZE_M, (sy / n) * CELL_SIZE_M, gate ? 6 : 0);
      const el = document.createElement('div');
      el.className = `crowd-label${gate ? ' gate' : ''}`;
      el.textContent = gate ? place.name.replace(/\s*\(.*\)/, '') : place.kind === 'seating' ? 'Ohio Stadium' : place.name;
      overlay.appendChild(el);
      this.labels.push({ el, sx: p.sx, sy: p.sy, gate });
    }
  }

  private bindInput(canvas: HTMLCanvasElement): void {
    let down: { x: number; y: number; camX: number; camY: number; moved: boolean } | null = null;
    const local = (e: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onDown = (e: PointerEvent) => {
      const p = local(e);
      down = { ...p, camX: this.cam.x, camY: this.cam.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const p = local(e);
      const dx = p.x - down.x;
      const dy = p.y - down.y;
      if (!down.moved && Math.hypot(dx, dy) < 4) return;
      if (!down.moved) this.setFollow(false);
      down.moved = true;
      this.cam.x = down.camX + dx;
      this.cam.y = down.camY + dy;
    };
    const onUp = (e: PointerEvent) => {
      if (down && !down.moved) {
        const p = local(e);
        this.init.onPick(this.pickAt(p.x, p.y));
      }
      down = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.style.cursor = 'grab';
    this.cleanup.push(() => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
    });
  }

  private setFollow(on: boolean): void {
    if (this.follow === on) return;
    this.follow = on;
    this.init.onFollowChange(on);
  }

  private viewSize(): { w: number; h: number } {
    const { host } = this.init;
    return { w: Math.max(1, host.clientWidth), h: Math.max(1, host.clientHeight) };
  }

  /** Zoom by a factor, keeping the point under (px, py) where it is. */
  zoomAt(px: number, py: number, factor: number): void {
    const next = Math.min(MAX_SCALE, Math.max(this.fitScale * 0.6, this.cam.scale * factor));
    const wx = (px - this.cam.x) / this.cam.scale;
    const wy = (py - this.cam.y) / this.cam.scale;
    this.cam.scale = next;
    this.cam.x = px - wx * next;
    this.cam.y = py - wy * next;
  }

  zoomBy(factor: number): void {
    const { w, h } = this.viewSize();
    this.zoomAt(w / 2, h / 2, factor);
  }

  fit(): void {
    const { map } = this.init;
    const W = map.width * CELL_SIZE_M;
    const H = map.height * CELL_SIZE_M;
    const { w, h } = this.viewSize();
    const isoW = W + H;
    const isoH = (W + H) / 2 + 24;
    this.fitScale = Math.min(w / isoW, h / isoH) * 0.94;
    this.cam.scale = this.fitScale;
    const cx = (W - H) / 2;
    const cy = (W + H) / 4 + 12;
    this.cam.x = w / 2 - cx * this.fitScale;
    this.cam.y = h / 2 - cy * this.fitScale;
    this.setFollow(false);
  }

  /** Centre on a group and zoom in far enough to see them as a person. */
  focus(dot: number): void {
    if (!this.app) {
      this.pendingFocus = dot;
      return;
    }
    const pos = this.positionOf(dot, performance.now());
    if (!pos) return;
    const { w, h } = this.viewSize();
    this.cam.scale = Math.max(this.cam.scale, 14);
    const p = isoProject(pos.x, pos.y, FIG_H / 2);
    this.cam.x = w / 2 - p.sx * this.cam.scale;
    this.cam.y = h / 2 - p.sy * this.cam.scale;
    this.setFollow(true);
  }

  setFollowing(on: boolean): void {
    this.setFollow(on);
  }

  setSelected(dot: number | null): void {
    this.selected = dot;
    if (dot === null) this.setFollow(false);
  }

  setTypes(typeIndex: Uint16Array | null): void {
    this.typeIndex = typeIndex;
  }

  setHeat(on: boolean): void {
    this.showHeat = on;
    if (this.heat) this.heat.sprite.visible = on;
  }

  setZone(cells: number[] | undefined): void {
    void this.ready.then(() => {
      const { width } = this.init.map;
      this.zone.clear();
      if (!cells || cells.length === 0) return;
      for (const cell of cells) this.zone.rect(cell % width, Math.floor(cell / width), 1, 1);
      this.zone.fill({ color: 0xffd166, alpha: 0.28 });
    });
  }

  /**
   * A new frame. Live frames tween from the last one over the gap between
   * arrivals, so people walk rather than hop every fifteen sim seconds; a
   * replayed frame is drawn exactly where it was.
   */
  setFrame(frame: SceneFrame, live: boolean): void {
    if (this.cur && frame.t === this.cur.t && frame.x === this.cur.x) return;
    const now = performance.now();
    if (this.cur && live) this.interval = Math.min(4000, Math.max(120, now - this.arrivedAt));
    this.prev = live && this.cur && frame.t > this.cur.t ? this.cur : null;
    this.cur = frame;
    this.arrivedAt = now;
    this.tween = live;
    void this.ready.then(() => this.paintFrame(frame));
  }

  private paintFrame(frame: SceneFrame): void {
    if (!this.app) return;
    const { map, dangerDensity } = this.init;
    if (frame.density && this.showHeat) {
      const data = this.heat.image.data;
      data.fill(0);
      const rho = frame.density;
      for (let i = 0; i < rho.length; i++) {
        const value = rho[i]!;
        if (value <= 0.08) continue;
        const ratio = Math.min(value / dangerDensity, 1.5);
        const o = i * 4;
        data[o] = Math.min(255, 90 + ratio * 165);
        data[o + 1] = Math.max(0, 180 - ratio * 170);
        data[o + 2] = 40;
        data[o + 3] = Math.min(220, ratio * 180);
      }
      this.heat.ctx.putImageData(this.heat.image, 0, 0);
      this.heat.texture.source.update();
    }

    const data = this.dots.image.data;
    data.fill(0);
    const gone = DOT_STATES.length - 1;
    const scale = 1 / CELL_SIZE_M;
    for (let i = 0; i < frame.x.length; i++) {
      const s = frame.state[i]!;
      if (s === gone || frame.x[i]! < 0) continue;
      const cx = (frame.x[i]! * scale) | 0;
      const cy = (frame.y[i]! * scale) | 0;
      if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) continue;
      const [r, g, b] = STATE_RGB[s] ?? STATE_RGB[3]!;
      const o = (cy * map.width + cx) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 240;
    }
    this.dots.ctx.putImageData(this.dots.image, 0, 0);
    this.dots.texture.source.update();
  }

  /** Where a group stands right now, tweened between the last two frames. */
  private positionOf(dot: number, now: number): { x: number; y: number; moving: boolean } | null {
    const cur = this.cur;
    if (!cur || dot < 0 || dot >= cur.x.length) return null;
    const x1 = cur.x[dot]!;
    const y1 = cur.y[dot]!;
    if (x1 < 0 || cur.state[dot] === DOT_STATES.length - 1) return null;
    const prev = this.prev;
    if (!prev || !this.tween) return { x: x1, y: y1, moving: false };
    const x0 = prev.x[dot]!;
    const y0 = prev.y[dot]!;
    if (x0 < 0) return { x: x1, y: y1, moving: false };
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist > MAX_TWEEN_M) return { x: x1, y: y1, moving: false };
    const a = Math.min(1, (now - this.arrivedAt) / this.interval);
    return { x: x0 + dx * a, y: y0 + dy * a, moving: dist > 0.4 && a < 1 };
  }

  private pickAt(px: number, py: number): number | null {
    const cur = this.cur;
    if (!cur) return null;
    const now = performance.now();
    const s = this.cam.scale;
    const asPeople = s >= PEOPLE_MIN_SCALE;
    const lift = asPeople ? FIG_H * 0.55 : 0;
    const reach = Math.max(10, asPeople ? FIG_H * s * 0.55 : 0);
    let best: number | null = null;
    let bestSq = reach * reach;
    for (let i = 0; i < cur.x.length; i++) {
      const pos = this.positionOf(i, now);
      if (!pos) continue;
      const p = isoProject(pos.x, pos.y, lift);
      const dx = p.sx * s + this.cam.x - px;
      const dy = p.sy * s + this.cam.y - py;
      const sq = dx * dx + dy * dy;
      if (sq < bestSq) {
        bestSq = sq;
        best = i;
      }
    }
    return best;
  }

  private person(index: number): Person {
    let p = this.pool[index];
    if (p) return p;
    const { parts } = this;
    const c = new Container();
    const shadow = new Sprite(parts.shadow);
    const ring = new Sprite(parts.ring);
    const legs = new Sprite(parts.legs[0]);
    const torso = new Sprite(parts.torso);
    const head = new Sprite(parts.head);
    for (const sprite of [shadow, ring]) {
      sprite.anchor.set(0.5);
      sprite.scale.set(1 / RES);
    }
    legs.anchor.set(0.5, 1);
    torso.anchor.set(0.5, 1);
    head.anchor.set(0.5, 1);
    for (const sprite of [legs, torso, head]) sprite.scale.set(1 / RES);
    legs.tint = LEGS;
    torso.y = -LEG_H + 0.05;
    head.y = -LEG_H - TORSO_H + 0.08;
    ring.alpha = 0.9;
    c.addChild(shadow, ring, legs, torso, head);
    this.people.addChild(c);
    p = { c, ring, legs, torso, head };
    this.pool[index] = p;
    return p;
  }

  private tick(): void {
    const app = this.app;
    if (!app) return;
    const now = performance.now();
    const { w, h } = this.viewSize();

    if (this.follow && this.selected !== null) {
      const pos = this.positionOf(this.selected, now);
      if (pos) {
        const p = isoProject(pos.x, pos.y, FIG_H / 2);
        const tx = w / 2 - p.sx * this.cam.scale;
        const ty = h / 2 - p.sy * this.cam.scale;
        this.cam.x += (tx - this.cam.x) * 0.12;
        this.cam.y += (ty - this.cam.y) * 0.12;
      }
    }

    const s = this.cam.scale;
    this.world.scale.set(s);
    this.world.position.set(this.cam.x, this.cam.y);

    const asPeople = s >= PEOPLE_MIN_SCALE;
    this.dots.sprite.alpha = asPeople ? 0.22 : 1;

    let used = 0;
    const cur = this.cur;
    if (asPeople && cur) {
      // Visible window in world units, padded by a figure so edges do not pop.
      const x0 = -this.cam.x / s - 4;
      const x1 = (w - this.cam.x) / s + 4;
      const y0 = -this.cam.y / s - 4;
      const y1 = (h - this.cam.y) / s + FIG_H + 4;
      const types = this.init.types;
      const show = (i: number) => {
        const pos = this.positionOf(i, now);
        if (!pos) return;
        const p = isoProject(pos.x, pos.y);
        if (i !== this.selected && (p.sx < x0 || p.sx > x1 || p.sy < y0 || p.sy > y1)) return;
        const person = this.person(used++);
        person.c.visible = true;
        person.c.position.set(p.sx, p.sy);
        person.c.zIndex = p.sy;
        const state = cur.state[i]!;
        person.ring.tint = rgbNum(STATE_RGB[state] ?? STATE_RGB[3]!);
        person.torso.tint = shirtColor(types, this.typeIndex?.[i] ?? 0);
        person.head.tint = skinOf(i);
        const seated = DOT_STATES[state] === 'seated';
        const step = pos.moving ? ((now / 140 + i * 0.37) | 0) % 4 : 0;
        person.legs.texture = this.parts.legs[step === 1 ? 1 : step === 3 ? 2 : 0]!;
        person.legs.scale.y = (seated ? 0.45 : 1) / RES;
        const bob = pos.moving && step % 2 === 1 ? -0.06 : 0;
        const drop = seated ? LEG_H * 0.55 : 0;
        person.torso.y = -LEG_H + 0.05 + drop + bob;
        person.head.y = -LEG_H - TORSO_H + 0.08 + drop + bob;
      };
      if (this.selected !== null) show(this.selected);
      for (let i = 0; i < cur.x.length && used < MAX_PEOPLE; i++) {
        if (i !== this.selected) show(i);
      }
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i]!.c.visible = false;

    this.drawOfficers(s);
    this.drawMarker(now, s, asPeople);

    for (const label of this.labels) {
      const x = label.sx * s + this.cam.x;
      const y = label.sy * s + this.cam.y;
      const visible = x > -80 && x < w + 80 && y > -20 && y < h + 20 && (!label.gate || s > this.fitScale * 1.6);
      label.el.style.display = visible ? '' : 'none';
      if (visible) label.el.style.transform = `translate(${x | 0}px, ${y | 0}px) translate(-50%, -100%)`;
    }
  }

  private drawOfficers(s: number): void {
    const cur = this.cur;
    this.officers.clear();
    if (!cur) return;
    const { width } = this.init.map;
    // Kept a readable size on screen however far out you are.
    const k = Math.max(1, PEOPLE_MIN_SCALE / s) * 1.1;
    for (const cell of cur.officerCells) {
      if (cell < 0) continue;
      const p = isoProject(((cell % width) + 0.5) * CELL_SIZE_M, (Math.floor(cell / width) + 0.5) * CELL_SIZE_M);
      this.officers.ellipse(p.sx, p.sy, 1.1 * k, 0.55 * k).fill({ color: OFFICER, alpha: 0.35 });
      this.officers.roundRect(p.sx - 0.42 * k, p.sy - 1.9 * k, 0.84 * k, 1.9 * k, 0.2 * k).fill(0x1f4f9a);
      this.officers.circle(p.sx, p.sy - 2.25 * k, 0.36 * k).fill(skinOf(cell));
      this.officers.rect(p.sx - 0.42 * k, p.sy - 2.62 * k, 0.84 * k, 0.22 * k).fill(0x0d2650);
    }
  }

  private drawMarker(now: number, s: number, asPeople: boolean): void {
    this.marker.clear();
    const dot = this.selected;
    const pos = dot === null ? null : this.positionOf(dot, now);
    if (dot === null || !pos) {
      this.nameTag.style.display = 'none';
      return;
    }
    const p = isoProject(pos.x, pos.y);
    const k = Math.max(1, PEOPLE_MIN_SCALE / s);
    const pulse = 1 + 0.15 * Math.sin(now / 220);
    this.marker
      .ellipse(p.sx, p.sy, 1.5 * k * pulse, 0.75 * k * pulse)
      .stroke({ color: 0xffd166, width: Math.max(0.12, 2 / s) });
    const top = p.sy - (asPeople ? FIG_H : 0) - 0.6 * k - Math.abs(Math.sin(now / 300)) * 0.35 * k;
    this.marker
      .poly([p.sx - 0.45 * k, top - 0.7 * k, p.sx + 0.45 * k, top - 0.7 * k, p.sx, top])
      .fill(0xffd166);
    const x = p.sx * s + this.cam.x;
    const y = (top - 0.9 * k) * s + this.cam.y;
    this.nameTag.style.display = '';
    this.nameTag.style.transform = `translate(${x | 0}px, ${y | 0}px) translate(-50%, -100%)`;
  }

  setName(text: string): void {
    this.nameTag.textContent = text;
  }

  /** Ground point under a screen position, for tests and tools. */
  groundAt(px: number, py: number): { mx: number; my: number } {
    return isoUnproject((px - this.cam.x) / this.cam.scale, (py - this.cam.y) / this.cam.scale);
  }

  destroy(): void {
    this.destroyed = true;
    for (const fn of this.cleanup) fn();
    for (const label of this.labels) label.el.remove();
    this.nameTag.remove();
    const app = this.app;
    this.app = null;
    // Wait for init to settle before tearing down; see ComparisonMaps.
    void this.ready.catch(() => {}).then(() => app?.destroy(true));
  }
}
