import { Application, Container, Graphics, Matrix, Sprite, Texture } from 'pixi.js';
import type { CellKind, FanType, MapBundle } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_STATES } from '../../contracts.ts';
import type { OfficerStatus, SceneInfo } from '../../engine/src/edits.ts';
import { policeStations } from '../../world/src/officers.ts';
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
/** Reached by an alert: their dot when zoomed out, and the ring. Magenta because seated fans are already light blue. */
const ALERTED = 0xff4fd8;
/** How long an alert stays lit on the map, in wall milliseconds. */
const ALERT_MS = 6000;
const CLOSED = 0xe5484d;

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
  /** An officer was clicked. Checked before fans: officers are few and easy to miss. */
  onPickOfficer: (id: string) => void;
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
  bubble: Sprite;
}

interface Parts {
  shadow: Texture;
  ring: Texture;
  legs: Texture[];
  torso: Texture;
  head: Texture;
  bubble: Texture;
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
  // A speech bubble with a megaphone: "this person just got the alert".
  const bubbleW = Math.round(1.3 * RES);
  const bubbleH = Math.round(1.15 * RES);
  const bubble = canvasTexture(bubbleW, bubbleH, (g) => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.roundRect(2, 2, bubbleW - 4, bubbleH * 0.78, 10);
    g.moveTo(bubbleW * 0.42, bubbleH * 0.78);
    g.lineTo(bubbleW * 0.5, bubbleH - 2);
    g.lineTo(bubbleW * 0.6, bubbleH * 0.78);
    g.fill();
    g.font = `${Math.round(bubbleH * 0.55)}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('📣', bubbleW / 2, bubbleH * 0.41);
  });
  return { shadow, ring, legs, torso, head, bubble };
}

/** A police post: a small blue booth with a light bar, in the depth-sorted layer with everyone else. */
function buildStation(cell: number, width: number): Graphics {
  const C = CELL_SIZE_M;
  const u = cell % width;
  const v = Math.floor(cell / width);
  const x0 = u * C - 1;
  const x1 = (u + 1) * C + 1;
  const y0 = v * C - 1;
  const y1 = (v + 1) * C + 1;
  const h = 3.2;
  const quad = (pts: [number, number, number][]) =>
    pts.flatMap(([mx, my, z]) => {
      const p = isoProject(mx, my, z);
      return [p.sx, p.sy];
    });
  const g = new Graphics();
  g.poly(quad([[x0 - 2, y1 + 2, 0], [x1 + 2, y1 + 2, 0], [x1 + 2, y0 - 2, 0], [x0 - 2, y0 - 2, 0]]), true).fill({ color: OFFICER, alpha: 0.28 });
  g.poly(quad([[x0, y1, 0], [x1, y1, 0], [x1, y1, h], [x0, y1, h]]), true).fill(0x1f4f9a);
  g.poly(quad([[x1, y0, 0], [x1, y1, 0], [x1, y1, h], [x1, y0, h]]), true).fill(0x2c66c2);
  g.poly(quad([[x0, y0, h], [x1, y0, h], [x1, y1, h], [x0, y1, h]]), true).fill(0xe6edf3);
  const mid = (x0 + x1) / 2;
  g.poly(quad([[mid - 1.2, y0 + 1, h], [mid, y0 + 1, h], [mid, y1 - 1, h], [mid - 1.2, y1 - 1, h]]), true).fill(0xe5484d);
  g.poly(quad([[mid, y0 + 1, h], [mid + 1.2, y0 + 1, h], [mid + 1.2, y1 - 1, h], [mid, y1 - 1, h]]), true).fill(OFFICER);
  g.zIndex = ((u + v + 2) * C) / 2;
  return g;
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

/** The stadium's outer wall: tall enough to read as the Horseshoe, low enough not to hide the stands. */
const SHELL_H = 9;
const SHELL_COLOR = 0xb9b2a4;

/**
 * Buildings as extruded cells: a roof per blocked cell and a wall wherever it
 * faces open ground to the south or east, the two faces this viewpoint sees.
 * Height and roof colour come from the connected building, so neighbouring
 * blocks read as separate buildings; thin pieces (fences) stay low, and the
 * ring touching the concourse is the stadium's own shell.
 *
 * Returned as one Graphics per diagonal (u + v), each with a zIndex, to be
 * sorted in with the people. In this projection every ground point on the
 * line u + v = d has the same screen depth, so a whole diagonal of building
 * sorts exactly against a figure: anyone standing behind it is drawn first and
 * hidden, anyone in front is drawn after. As one layer under the crowd, a fan
 * walking behind a building was painted over its roof, which read as people
 * walking on top of buildings or stuck inside them.
 */
function buildBuildings(map: MapBundle): Graphics[] {
  const { width, height, cells } = map;
  const blocked = (u: number, v: number) => u >= 0 && v >= 0 && u < width && v < height && cells[v * width + u] === 'blocked';

  const label = new Int32Array(width * height).fill(-1);
  const sizes: number[] = [];
  const shells = new Set<number>();
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
        const nu = u + du;
        const nv = v + dv;
        if (nu >= 0 && nv >= 0 && nu < width && nv < height && cells[nv * width + nu] === 'concourse') shells.add(id);
        if (!blocked(nu, nv)) continue;
        const next = nv * width + nu;
        if (label[next]! >= 0) continue;
        label[next] = id;
        stack.push(next);
      }
    }
    sizes.push(size);
  }
  const heightOf = (id: number) => (shells.has(id) ? SHELL_H : sizes[id]! < 40 ? 2.5 : 7 + (hash(id) % 5) * 3);
  const roofOf = (id: number) => (shells.has(id) ? SHELL_COLOR : ROOFS[hash(id + 101) % ROOFS.length]!);

  const C = CELL_SIZE_M;
  const quad = (pts: [number, number, number][]) =>
    pts.flatMap(([mx, my, h]) => {
      const p = isoProject(mx, my, h);
      return [p.sx, p.sy];
    });

  const diagonals = new Map<number, Graphics>();
  for (let d = 0; d <= width + height - 2; d++) {
    // Walls first, then roofs, west to east along the diagonal.
    let g: Graphics | null = null;
    const roofs: [number, number, number][][] = [];
    const colors: number[] = [];
    for (let u = Math.max(0, d - height + 1); u <= Math.min(d, width - 1); u++) {
      const v = d - u;
      const id = label[v * width + u]!;
      if (id < 0) continue;
      g ??= new Graphics();
      const h = heightOf(id);
      const roof = roofOf(id);
      const x0 = u * C;
      const x1 = (u + 1) * C;
      const y0 = v * C;
      const y1 = (v + 1) * C;
      if (!blocked(u, v + 1)) g.poly(quad([[x0, y1, 0], [x1, y1, 0], [x1, y1, h], [x0, y1, h]]), true).fill(shade(roof, 0.58));
      if (!blocked(u + 1, v)) g.poly(quad([[x1, y0, 0], [x1, y1, 0], [x1, y1, h], [x1, y0, h]]), true).fill(shade(roof, 0.76));
      roofs.push([[x0, y0, h], [x1, y0, h], [x1, y1, h], [x0, y1, h]]);
      colors.push(roof);
    }
    if (!g) continue;
    roofs.forEach((r, k) => g!.poly(quad(r), true).fill(colors[k]!));
    // Just before a figure standing on the line in front of this diagonal.
    g.zIndex = ((d + 1) * C) / 2 - 0.001;
    diagonals.set(d, g);
  }
  return [...diagonals.values()];
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
  private closedCells = new Graphics();
  private routes = new Graphics();
  private ripple = new Graphics();
  private scene: SceneInfo | null = null;
  private prevScene: SceneInfo | null = null;
  private closedKey = '';
  private closedTags: { el: HTMLElement; sx: number; sy: number }[] = [];
  private selectedOfficer: string | null = null;
  /** Who the last alert reached, and when it went out (wall clock). */
  private alert: { mask: Uint8Array; start: number; mx: number; my: number; radius: number } | null = null;
  private heat!: Layer;
  private dots!: Layer;
  private parts!: Parts;
  private pool: Person[] = [];
  private labels: { el: HTMLElement; sx: number; sy: number; gate: boolean }[] = [];
  private stationTags: { el: HTMLElement; sx: number; sy: number }[] = [];
  private nameTag: HTMLElement;
  private zoneTag: HTMLElement;
  private zoneAt: { sx: number; sy: number } | null = null;

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
    this.zoneTag = document.createElement('div');
    this.zoneTag.className = 'crowd-label incident';
    this.zoneTag.style.display = 'none';
    init.overlay.appendChild(this.zoneTag);
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
    this.ground.addChild(new Sprite(baseTexture), this.heat.sprite, this.zone, this.closedCells, this.dots.sprite);

    this.people.sortableChildren = true;
    this.people.addChild(...buildBuildings(map));
    for (const station of policeStations(map)) this.people.addChild(buildStation(station.cell, map.width));
    this.world.addChild(slab, this.ground, this.routes, this.people, this.ripple, this.officers, this.marker);
    app.stage.addChild(this.world);

    this.makeLabels();
    this.bindInput(app.canvas);
    this.fit();
    // Open on the incident, close enough that the crowd already reads as people.
    if (this.zoneAt) this.lookAt(this.zoneAt, PEOPLE_MIN_SCALE * 1.15);
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
    for (const station of policeStations(map)) {
      const p = isoProject(((station.cell % map.width) + 0.5) * CELL_SIZE_M, (Math.floor(station.cell / map.width) + 0.5) * CELL_SIZE_M, 5);
      const el = document.createElement('div');
      el.className = 'crowd-label station';
      el.textContent = `🚓 ${station.name}`;
      overlay.appendChild(el);
      this.stationTags.push({ el, sx: p.sx, sy: p.sy });
    }
  }

  /**
   * Officers, closures and alerts from the worker, so a plan's steps can be
   * seen happening: officers walking in from their post, a gate door shut, the
   * people an alert reached.
   */
  setScene(info: SceneInfo | null, live: boolean): void {
    this.prevScene = live && this.scene && info && info.t > this.scene.t ? this.scene : null;
    this.scene = info;
    const key = info ? [...info.closed].sort().join(',') : '';
    if (key !== this.closedKey) {
      this.closedKey = key;
      void this.ready.then(() => this.drawClosed(info?.closed ?? []));
    }
  }

  /** Light up the people an alert just reached, and send a ring out over them. */
  flashAlert(dots: Int32Array): void {
    const cur = this.cur;
    if (!cur) return;
    const mask = new Uint8Array(cur.x.length);
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const dot of dots) {
      if (dot < 0 || dot >= mask.length || cur.x[dot]! < 0) continue;
      mask[dot] = 1;
      sx += cur.x[dot]!;
      sy += cur.y[dot]!;
      n++;
    }
    if (n === 0) return;
    const mx = sx / n;
    const my = sy / n;
    let far = 0;
    for (const dot of dots) {
      if (mask[dot] !== 1) continue;
      far = Math.max(far, Math.hypot(cur.x[dot]! - mx, cur.y[dot]! - my));
    }
    this.alert = { mask, start: performance.now(), mx, my, radius: Math.max(40, Math.min(far, 900)) };
    this.paintFrame(cur);
  }

  setSelectedOfficer(id: string | null): void {
    this.selectedOfficer = id;
  }

  private drawClosed(ids: string[]): void {
    const { map, overlay } = this.init;
    const { width } = map;
    this.closedCells.clear();
    for (const tag of this.closedTags) tag.el.remove();
    this.closedTags = [];
    for (const id of ids) {
      const closable = map.closables.find((c) => c.id === id);
      if (!closable || closable.cells.length === 0) continue;
      let u = 0;
      let v = 0;
      for (const cell of closable.cells) {
        this.closedCells.rect(cell % width, Math.floor(cell / width), 1, 1);
        u += (cell % width) + 0.5;
        v += Math.floor(cell / width) + 0.5;
      }
      const n = closable.cells.length;
      const p = isoProject((u / n) * CELL_SIZE_M, (v / n) * CELL_SIZE_M, 4);
      const el = document.createElement('div');
      el.className = 'crowd-label closed';
      el.textContent = `⛔ ${closable.name.replace(/ door$/, '')} closed`;
      overlay.appendChild(el);
      this.closedTags.push({ el, sx: p.sx, sy: p.sy });
    }
    this.closedCells.fill({ color: CLOSED, alpha: 0.7 });
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
        const officer = this.officerAt(p.x, p.y);
        if (officer !== null) this.init.onPickOfficer(officer);
        else this.init.onPick(this.pickAt(p.x, p.y));
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

  private lookAt(p: { sx: number; sy: number }, scale: number): void {
    const { w, h } = this.viewSize();
    this.cam.scale = Math.min(MAX_SCALE, Math.max(this.cam.scale, scale));
    this.cam.x = w / 2 - p.sx * this.cam.scale;
    this.cam.y = h / 2 - p.sy * this.cam.scale;
  }

  /** Back to the incident, for the "incident" button. */
  showIncident(): void {
    if (this.zoneAt) this.lookAt(this.zoneAt, PEOPLE_MIN_SCALE * 1.15);
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

  /** The incident zone, tinted on the ground and labelled so a first-time viewer knows where to look. */
  setZone(cells: number[] | undefined, label?: string): void {
    this.zoneTag.textContent = label ? `⚠ ${label}` : '';
    this.zoneAt = null;
    if (cells && cells.length > 0) {
      const { width } = this.init.map;
      let u = 0;
      let v = 0;
      for (const cell of cells) {
        u += (cell % width) + 0.5;
        v += Math.floor(cell / width) + 0.5;
      }
      this.zoneAt = isoProject((u / cells.length) * CELL_SIZE_M, (v / cells.length) * CELL_SIZE_M, 4);
    }
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
      const lit = this.alert?.mask[i] === 1;
      const [r, g, b] = lit ? [(ALERTED >> 16) & 255, (ALERTED >> 8) & 255, ALERTED & 255] : (STATE_RGB[s] ?? STATE_RGB[3]!);
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

  /** The officer under a screen point, if any. */
  private officerAt(px: number, py: number): string | null {
    const s = this.cam.scale;
    const k = Math.max(1, PEOPLE_MIN_SCALE / s) * 1.1;
    const reach = Math.max(12, 2 * k * s);
    let best: string | null = null;
    let bestSq = reach * reach;
    for (const o of this.officerPositions(performance.now())) {
      const p = isoProject(o.x, o.y, 1.2 * k);
      const dx = p.sx * s + this.cam.x - px;
      const dy = p.sy * s + this.cam.y - py;
      const sq = dx * dx + dy * dy;
      if (sq < bestSq) {
        bestSq = sq;
        best = o.id;
      }
    }
    return best;
  }

  /** Officers where they stand right now, tweened like the crowd. */
  private officerPositions(now: number): (OfficerStatus & { x: number; y: number })[] {
    const scene = this.scene;
    if (!scene) return [];
    const prev = this.prevScene;
    const a = this.tween ? Math.min(1, (now - this.arrivedAt) / this.interval) : 1;
    return scene.officers.map((o) => {
      const before = prev?.officers.find((p) => p.id === o.id);
      if (!before || Math.hypot(o.x - before.x, o.y - before.y) > MAX_TWEEN_M * 3) return o;
      return { ...o, x: before.x + (o.x - before.x) * a, y: before.y + (o.y - before.y) * a };
    });
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
    const bubble = new Sprite(parts.bubble);
    bubble.anchor.set(0.5, 1);
    bubble.scale.set(1 / RES);
    bubble.y = -FIG_H - 0.15;
    bubble.visible = false;
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
    c.addChild(shadow, ring, legs, torso, head, bubble);
    this.people.addChild(c);
    p = { c, ring, legs, torso, head, bubble };
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

    // An alert stays lit for a few seconds, then the dots go back to their state colours.
    const alertLive = this.alert !== null && now - this.alert.start < ALERT_MS;
    if (this.alert && !alertLive) {
      this.alert = null;
      if (this.cur) this.paintFrame(this.cur);
    }
    this.drawRipple(now);

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
        person.bubble.visible = alertLive && this.alert!.mask[i] === 1;
        person.bubble.y = -FIG_H - 0.15 + drop;
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
    for (const tag of [...this.stationTags, ...this.closedTags]) {
      const x = tag.sx * s + this.cam.x;
      const y = tag.sy * s + this.cam.y;
      const visible = x > -120 && x < w + 120 && y > -20 && y < h + 40;
      tag.el.style.display = visible ? '' : 'none';
      if (visible) tag.el.style.transform = `translate(${x | 0}px, ${y | 0}px) translate(-50%, -100%)`;
    }
    const zone = this.zoneAt;
    if (zone && this.zoneTag.textContent) {
      const x = zone.sx * s + this.cam.x;
      const y = zone.sy * s + this.cam.y;
      this.zoneTag.style.display = '';
      // Lifted clear of the gate label that usually sits at the same spot.
      this.zoneTag.style.transform = `translate(${x | 0}px, ${(y | 0) - 26}px) translate(-50%, -100%)`;
    } else {
      this.zoneTag.style.display = 'none';
    }
  }

  private drawOfficers(s: number): void {
    const cur = this.cur;
    this.officers.clear();
    this.routes.clear();
    if (!cur) return;
    const { width } = this.init.map;
    // Kept a readable size on screen however far out you are.
    const k = Math.max(1, PEOPLE_MIN_SCALE / s) * 1.1;
    const centre = (cell: number) => isoProject(((cell % width) + 0.5) * CELL_SIZE_M, (Math.floor(cell / width) + 0.5) * CELL_SIZE_M);
    const officers = this.scene
      ? this.officerPositions(performance.now())
      : Array.from(cur.officerCells, (cell, i) => ({
          id: `off-${i + 1}`,
          x: ((cell % width) + 0.5) * CELL_SIZE_M,
          y: (Math.floor(cell / width) + 0.5) * CELL_SIZE_M,
          state: 'standby' as OfficerStatus['state'],
          targetCell: -1,
        }));

    for (const o of officers) {
      const p = isoProject(o.x, o.y);
      // Where they are headed: a dotted line to the post, so a dispatch is visible.
      if (o.state === 'en_route' && o.targetCell >= 0) {
        const t = centre(o.targetCell);
        const len = Math.hypot(t.sx - p.sx, t.sy - p.sy);
        const dash = Math.max(1.5, 6 / s);
        for (let d = 0; d < len; d += dash * 2) {
          const a = d / len;
          const b = Math.min(1, (d + dash) / len);
          this.routes.moveTo(p.sx + (t.sx - p.sx) * a, p.sy + (t.sy - p.sy) * a).lineTo(p.sx + (t.sx - p.sx) * b, p.sy + (t.sy - p.sy) * b);
        }
        this.routes.stroke({ color: OFFICER, width: Math.max(0.25, 2 / s), alpha: 0.85 });
        this.routes.circle(t.sx, t.sy, 1.4 * k).stroke({ color: OFFICER, width: Math.max(0.2, 1.5 / s) });
      }
      if (o.id === this.selectedOfficer) {
        this.officers.ellipse(p.sx, p.sy, 2.1 * k, 1.05 * k).stroke({ color: 0xffd166, width: Math.max(0.15, 2.5 / s) });
      }
      this.officers.ellipse(p.sx, p.sy, 1.1 * k, 0.55 * k).fill({ color: OFFICER, alpha: o.state === 'on_scene' ? 0.55 : 0.35 });
      this.officers.roundRect(p.sx - 0.42 * k, p.sy - 1.9 * k, 0.84 * k, 1.9 * k, 0.2 * k).fill(0x1f4f9a);
      this.officers.circle(p.sx, p.sy - 2.25 * k, 0.36 * k).fill(skinOf(Number(o.id.replace(/\D/g, '')) * 7919));
      this.officers.rect(p.sx - 0.42 * k, p.sy - 2.62 * k, 0.84 * k, 0.22 * k).fill(0x0d2650);
    }
  }

  /** Rings spreading over the people an alert reached, for its first couple of seconds. */
  private drawRipple(now: number): void {
    this.ripple.clear();
    const alert = this.alert;
    if (!alert) return;
    const age = (now - alert.start) / 2400;
    if (age > 1.4) return;
    const s = this.cam.scale;
    const p = isoProject(alert.mx, alert.my);
    for (let ring = 0; ring < 3; ring++) {
      const f = age - ring * 0.2;
      if (f <= 0 || f > 1) continue;
      const r = alert.radius * f;
      // A circle on the ground is an ellipse twice as wide as it is tall here.
      this.ripple.ellipse(p.sx, p.sy, r * Math.SQRT2, r / Math.SQRT2).stroke({ color: ALERTED, width: Math.max(0.6, 3 / s), alpha: 1 - f });
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
    for (const tag of [...this.stationTags, ...this.closedTags]) tag.el.remove();
    this.nameTag.remove();
    this.zoneTag.remove();
    const app = this.app;
    this.app = null;
    // Wait for init to settle before tearing down; see ComparisonMaps.
    void this.ready.catch(() => {}).then(() => app?.destroy(true));
  }
}
