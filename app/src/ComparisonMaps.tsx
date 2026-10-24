import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { CellKind, MapBundle, VehicleFrame, VehicleKind, WeatherState } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_STATES, VEHICLE_KINDS, VEHICLE_STATES } from '../../contracts.ts';
import { roadNetFor } from '../../engine/src/traffic.ts';
import { VEHICLE_TYPES } from '../../world/src/vehicles.ts';
import { bandOf, heatBands } from './heat.ts';
import { STATE_RGB } from './people.ts';
import type { RunHandle, RunSnapshotView } from './useRun.ts';
import { drawVehicle } from './vehicleArt.ts';
import { readoutOf, ReadoutChips } from './Readouts.tsx';
import { WeatherFx } from './WeatherFx.tsx';

/**
 * All three runs in ONE PixiJS Application, plus two plain canvases on top.
 *
 * Three Applications meant three WebGL contexts and Pixi's GPU probe paid three
 * times, so the map, the banded heatmap and the incident zone live in one Pixi
 * stage as three masked panels sharing one base texture. Fans, vehicles and
 * officers are drawn on a 2D canvas over it: vehicles are rotated, detailed
 * shapes at their real size, which is what Canvas2D is good at, and fans stay
 * pixel bytes. Weather animates on a third canvas on its own clock.
 *
 * Zoom and pan are shared by all three panels — the point is comparing the same
 * spot under three plans — and between frames the canvas glides each fan and
 * vehicle from where it was to where it is, so 15 sim seconds between frames
 * reads as motion rather than a slideshow.
 */
const TARGET_PANEL_PX = 760;
const GAP_PX = 10;
const MAX_ZOOM = 48;
const FPS_MS = 1000 / 40;

const pxPerCell = (map: MapBundle) => Math.max(1, Math.round(TARGET_PANEL_PX / map.width));

/** Base map palette: lawns, asphalt, lots, buildings, the bowl. */
const RGB: Record<CellKind, [number, number, number]> = {
  blocked: [0x15, 0x1a, 0x21],
  walk: [0x1d, 0x29, 0x24],
  road: [0x3b, 0x40, 0x48],
  stands: [0x4a, 0x22, 0x26],
  concourse: [0x37, 0x41, 0x4d],
  shelter: [0x2c, 0x40, 0x38],
  parking: [0x2c, 0x30, 0x37],
};

const VS = Object.fromEntries(VEHICLE_STATES.map((s, i) => [s, i])) as Record<(typeof VEHICLE_STATES)[number], number>;

/** The static map as pixel bytes, with building edges lit and a little texture on the grass. */
function paintBase(map: MapBundle): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = map.width;
  canvas.height = map.height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(map.width, map.height);
  const data = image.data;
  const W = map.width;
  for (let i = 0; i < map.cells.length; i++) {
    const kind = map.cells[i]!;
    let [r, g, b] = RGB[kind];
    const x = i % W;
    const y = (i / W) | 0;
    if (kind === 'blocked') {
      // Roofs read as raised: lighter where they meet open ground.
      const open = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < W && yy < map.height && map.cells[yy * W + xx] !== 'blocked';
      if (open(x - 1, y) || open(x, y - 1)) [r, g, b] = [0x2e, 0x37, 0x43];
      else if (open(x + 1, y) || open(x, y + 1)) [r, g, b] = [0x0e, 0x12, 0x17];
    } else if (kind === 'walk') {
      const n = (((x * 73856093) ^ (y * 19349663)) >>> 0) % 7;
      g += n - 3;
      r += (n >> 1) - 1;
    } else if (kind === 'road') {
      const n = (((x * 2654435761) ^ (y * 40503)) >>> 0) % 5;
      r += n - 2;
      g += n - 2;
      b += n - 2;
    }
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

interface Layer {
  canvas: HTMLCanvasElement;
  texture: Texture;
  image: ImageData;
}

interface Panel {
  world: Container;
  heat: Layer;
  zone: Graphics;
}

function makeLayer(width: number, height: number, smooth: boolean): Layer {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = smooth ? 'linear' : 'nearest';
  return { canvas, texture, image };
}

/** Shared camera, in zoom-1 panel pixels. */
export interface View {
  z: number;
  cx: number;
  cy: number;
}

export type MapPick =
  | { type: 'dot'; run: number; dot: number }
  | { type: 'vehicle'; run: number; vehicle: number }
  | { type: 'cell'; run: number; cell: number; band: number; density: number };

export interface FocusBox {
  /** Cell bounds to fit, inclusive. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  nonce: number;
}

export interface ComparisonMapsProps {
  map: MapBundle;
  runs: RunHandle[];
  /** Replay frame to draw, or null to follow the live runs. */
  scrubIndex: number | null;
  dangerDensity: number;
  incidentCells?: number[];
  playing: boolean;
  selectedBand: number | null;
  vehicleFocus: VehicleKind | null;
  showVehicles: boolean;
  picked: MapPick | null;
  focus: FocusBox | null;
  onPick?: (pick: MapPick | null) => void;
}

interface Drawn {
  x: Float32Array;
  y: Float32Array;
  state: Uint8Array;
  vehicles?: VehicleFrame;
  vx?: Float32Array;
  vy?: Float32Array;
  vh?: Float32Array;
}

const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

/** Positions to draw this instant: the latest frame, or partway from the one before. */
function blend(prev: RunSnapshotView | null, latest: RunSnapshotView, alpha: number, into: Drawn | undefined): Drawn {
  const f = latest.frame;
  if (!prev || alpha >= 1 || prev.frame.x.length !== f.x.length) {
    return { x: f.x, y: f.y, state: f.state, vehicles: f.vehicles, vx: f.vehicles?.x, vy: f.vehicles?.y, vh: f.vehicles?.heading };
  }
  const n = f.x.length;
  const x = into && into.x !== f.x && into.x.length === n ? into.x : new Float32Array(n);
  const y = into && into.y !== f.y && into.y.length === n ? into.y : new Float32Array(n);
  const px = prev.frame.x;
  const py = prev.frame.y;
  for (let i = 0; i < n; i++) {
    const ax = px[i]!;
    const bx = f.x[i]!;
    // Fans who just arrived, or jumped (rewind), appear where they are.
    if (ax < 0 || bx < 0 || Math.abs(bx - ax) > 40 || Math.abs(f.y[i]! - py[i]!) > 40) {
      x[i] = bx;
      y[i] = f.y[i]!;
    } else {
      x[i] = ax + (bx - ax) * alpha;
      y[i] = py[i]! + (f.y[i]! - py[i]!) * alpha;
    }
  }
  const out: Drawn = { x, y, state: f.state, vehicles: f.vehicles };
  const va = prev.frame.vehicles;
  const vb = f.vehicles;
  if (va && vb && va.x.length === vb.x.length) {
    const m = vb.x.length;
    const vx = into?.vx && into.vx !== vb.x && into.vx.length === m ? into.vx : new Float32Array(m);
    const vy = into?.vy && into.vy !== vb.y && into.vy.length === m ? into.vy : new Float32Array(m);
    const vh = into?.vh && into.vh !== vb.heading && into.vh.length === m ? into.vh : new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const ax = va.x[i]!;
      const bx = vb.x[i]!;
      if (ax < 0 || bx < 0 || Math.abs(bx - ax) > 260 || Math.abs(vb.y[i]! - va.y[i]!) > 260) {
        vx[i] = bx;
        vy[i] = vb.y[i]!;
        vh[i] = vb.heading[i]!;
      } else {
        vx[i] = ax + (bx - ax) * alpha;
        vy[i] = va.y[i]! + (vb.y[i]! - va.y[i]!) * alpha;
        vh[i] = lerpAngle(va.heading[i]!, vb.heading[i]!, alpha);
      }
    }
    out.vx = vx;
    out.vy = vy;
    out.vh = vh;
  } else if (vb) {
    out.vx = vb.x;
    out.vy = vb.y;
    out.vh = vb.heading;
  }
  return out;
}

const darkSky = (w?: WeatherState) =>
  !!w && (w.kind === 'rain' || w.kind === 'heavy_rain' || w.kind === 'thunderstorm' || w.kind === 'fog' || w.kind === 'snow' || (w.kind === 'overcast' && w.intensity > 0.4));


export function ComparisonMaps(props: ComparisonMapsProps) {
  const { map, runs, scrubIndex, dangerDensity, incidentCells, selectedBand, vehicleFocus, showVehicles, picked, focus, onPick } = props;
  const PX = pxPerCell(map);
  const panelW = map.width * PX;
  const panelH = map.height * PX;
  const totalW = panelW * 3 + GAP_PX * 2;
  const bands = useMemo(() => heatBands(dangerDensity), [dangerDensity]);
  const net = useMemo(() => (map.width > 200 ? roadNetFor(map) : null), [map]);

  const pixiRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<Application | null>(null);
  const panelsRef = useRef<Panel[]>([]);
  const drawnRef = useRef<(Drawn | undefined)[]>([]);
  const fit: View = { z: 1, cx: panelW / 2, cy: panelH / 2 };
  const viewRef = useRef<View>(fit);
  const [viewTick, setViewTick] = useState(0);
  const [pixiReady, setPixiReady] = useState(0);
  const flyRef = useRef<{ from: View; to: View; start: number; ms: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const needsRef = useRef(true);
  const propsRef = useRef(props);
  propsRef.current = props;

  const clampView = useCallback(
    (v: View): View => {
      const z = Math.min(MAX_ZOOM, Math.max(1, v.z));
      const hw = panelW / (2 * z);
      const hh = panelH / (2 * z);
      return { z, cx: Math.min(panelW - hw, Math.max(hw, v.cx)), cy: Math.min(panelH - hh, Math.max(hh, v.cy)) };
    },
    [panelW, panelH],
  );

  const setView = useCallback(
    (v: View) => {
      viewRef.current = clampView(v);
      needsRef.current = true;
      setViewTick((t) => t + 1);
    },
    [clampView],
  );

  const flyTo = useCallback(
    (to: View, ms = 650) => {
      flyRef.current = { from: { ...viewRef.current }, to: clampView(to), start: performance.now(), ms };
      needsRef.current = true;
    },
    [clampView],
  );

  // ─── Pixi: base map, heat, zone ───
  useEffect(() => {
    const canvas = pixiRef.current;
    if (!canvas) return;
    let disposed = false;
    const app = new Application();
    const ready = app
      .init({ canvas, width: totalW, height: panelH, background: 0x05070a, antialias: false })
      .then(() => {
        if (disposed) return;
        const baseTexture = Texture.from(paintBase(map));
        baseTexture.source.scaleMode = 'nearest';
        const panels: Panel[] = [];
        for (let i = 0; i < 3; i++) {
          const group = new Container();
          group.x = i * (panelW + GAP_PX);
          const mask = new Graphics().rect(0, 0, panelW, panelH).fill(0xffffff);
          group.addChild(mask);
          group.mask = mask;
          const world = new Container();
          const base = new Sprite(baseTexture);
          base.setSize(panelW, panelH);
          const heat = makeLayer(map.width, map.height, true);
          const heatSprite = new Sprite(heat.texture);
          heatSprite.setSize(panelW, panelH);
          const zone = new Graphics();
          world.addChild(base, heatSprite, zone);
          group.addChild(world);
          app.stage.addChild(group);
          panels.push({ world, heat, zone });
        }
        panelsRef.current = panels;
        appRef.current = app;
        app.ticker.stop();
        needsRef.current = true;
        setPixiReady((n) => n + 1);
      });
    return () => {
      disposed = true;
      panelsRef.current = [];
      appRef.current = null;
      void ready.catch(() => {}).then(() => app.destroy(true));
    };
  }, [map, panelW, panelH, totalW, PX]);

  const ticks = runs.map((r) => r.tick).join(',');

  /** The frame each panel shows: the scrubbed one, or the live one. */
  const viewFor = useCallback(
    (run: RunHandle): RunSnapshotView | null => {
      const kept = run.frames.current ?? [];
      if (scrubIndex === null) return run.latest.current;
      return kept[Math.min(scrubIndex, kept.length - 1)] ?? run.latest.current;
    },
    [scrubIndex],
  );

  // Heat bands, repainted when a frame lands or the selected band changes.
  useEffect(() => {
    const panels = panelsRef.current;
    if (panels.length < 3) return;
    runs.forEach((run, index) => {
      const view = viewFor(run);
      const panel = panels[index]!;
      const data = panel.heat.image.data;
      data.fill(0);
      if (view?.density) {
        const { peoplePerM2 } = view.density;
        for (let i = 0; i < peoplePerM2.length; i++) {
          const b = bandOf(peoplePerM2[i]!, bands);
          if (b < 0) continue;
          const band = bands[b]!;
          const o = i * 4;
          const lit = selectedBand === null || selectedBand === b;
          data[o] = band.rgb[0];
          data[o + 1] = band.rgb[1];
          data[o + 2] = band.rgb[2];
          data[o + 3] = Math.round(255 * (lit ? (selectedBand === b ? 0.98 : band.alpha) : 0.07));
        }
      }
      panel.heat.canvas.getContext('2d')!.putImageData(panel.heat.image, 0, 0);
      panel.heat.texture.source.update();
    });
    needsRef.current = true;
  }, [ticks, scrubIndex, runs, bands, selectedBand, viewFor, pixiReady]);

  // The incident zone, outlined when it changes — and re-stroked after a zoom,
  // so the outline stays a hairline rather than thickening with the map.
  const settledZoom = Math.round(viewRef.current.z * 4) / 4;
  useEffect(() => {
    const panels = panelsRef.current;
    if (panels.length < 3) return;
    for (const panel of panels) {
      panel.zone.clear();
      if (!incidentCells || incidentCells.length === 0) continue;
      for (const cell of incidentCells) panel.zone.rect((cell % map.width) * PX, Math.floor(cell / map.width) * PX, PX, PX);
      panel.zone.fill({ color: 0xffd166, alpha: 0.06 });
      panel.zone.stroke({ color: 0xffd166, width: 1.2 / settledZoom, alpha: 0.6 });
    }
    needsRef.current = true;
  }, [incidentCells, map, PX, settledZoom, pixiReady]);

  // Fly to a box the app asked for (a hotspot, the incident, the stadium).
  useEffect(() => {
    if (!focus) return;
    const w = (focus.x1 - focus.x0 + 1) * PX;
    const h = (focus.y1 - focus.y0 + 1) * PX;
    const z = Math.min(MAX_ZOOM, Math.max(1, Math.min(panelW / (w * 1.6 + 20), panelH / (h * 1.6 + 20))));
    flyTo({ z, cx: ((focus.x0 + focus.x1 + 1) / 2) * PX, cy: ((focus.y0 + focus.y1 + 1) / 2) * PX });
  }, [focus, PX, panelW, panelH, flyTo]);

  useEffect(() => {
    needsRef.current = true;
  }, [ticks, scrubIndex, selectedBand, vehicleFocus, showVehicles, picked]);

  // ─── the draw loop ───
  useEffect(() => {
    const live = liveRef.current;
    if (!live) return;
    live.width = totalW;
    live.height = panelH;
    const ctx = live.getContext('2d')!;
    const dotImage = ctx.createImageData(totalW, panelH);
    let raf = 0;
    let lastDraw = 0;

    const draw = (now: number) => {
      const p = propsRef.current;
      const fly = flyRef.current;
      if (fly) {
        const k = Math.min(1, (now - fly.start) / fly.ms);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        // Zoom moves in log space so the flight feels even.
        const z = Math.exp(Math.log(fly.from.z) + (Math.log(fly.to.z) - Math.log(fly.from.z)) * e);
        viewRef.current = clampView({ z, cx: fly.from.cx + (fly.to.cx - fly.from.cx) * e, cy: fly.from.cy + (fly.to.cy - fly.from.cy) * e });
        if (k >= 1) {
          flyRef.current = null;
          setViewTick((t) => t + 1);
        }
        needsRef.current = true;
      }

      const animating = p.playing && p.scrubIndex === null;
      const anyFlashing = p.runs.some((r) => {
        const v = r.latest.current?.frame.vehicles;
        if (!v) return false;
        for (let i = v.state.length - 2; i < v.state.length; i++) if (i >= 0 && v.state[i] === VS.responding) return true;
        return false;
      });
      const due = now - lastDraw >= FPS_MS;
      if ((needsRef.current || animating || anyFlashing || fly) && due) {
        lastDraw = now;
        needsRef.current = false;
        render(now);
      }
      raf = requestAnimationFrame(draw);
    };

    const render = (now: number) => {
      const p = propsRef.current;
      const app = appRef.current;
      const panels = panelsRef.current;
      const v = viewRef.current;
      const z = v.z;
      const m2px = (z * PX) / CELL_SIZE_M; // screen px per meter
      if (app && panels.length === 3) {
        for (const panel of panels) {
          panel.world.scale.set(z);
          panel.world.position.set(panelW / 2 - v.cx * z, panelH / 2 - v.cy * z);
        }
        app.render();
      }

      const toX = (mx: number) => ((mx * PX) / CELL_SIZE_M - v.cx) * z + panelW / 2;
      const toY = (my: number) => ((my * PX) / CELL_SIZE_M - v.cy) * z + panelH / 2;

      // Fans, as pixel bytes. Bigger, rounder dots as you zoom in.
      const data = dotImage.data;
      data.fill(0);
      const gone = DOT_STATES.length - 1;
      const radius = z < 2 ? 0 : z < 4 ? 1 : z < 9 ? 2 : z < 18 ? 3 : 4;
      const round = radius >= 2;
      const drawn: (Drawn | undefined)[] = [];
      p.runs.forEach((run, index) => {
        const latest = p.scrubIndex === null ? run.latest.current : null;
        const view = latest ?? viewFor(run);
        if (!view) return;
        let alpha = 1;
        const prev = p.scrubIndex === null ? run.previous.current : null;
        if (prev && latest?.at !== undefined && prev.at !== undefined && p.playing) {
          const span = Math.max(150, latest.at - prev.at);
          alpha = Math.min(1, Math.max(0, (now - latest.at) / span));
        }
        const d = blend(alpha < 1 ? prev : null, view, alpha, drawnRef.current[index]);
        drawn[index] = d;
        const ox = index * (panelW + GAP_PX);
        const { x, y, state } = d;
        for (let i = 0; i < x.length; i++) {
          const s = state[i]!;
          if (s === gone || x[i]! < 0) continue;
          const cx = toX(x[i]!) | 0;
          const cy = toY(y[i]!) | 0;
          if (cx < -radius || cy < -radius || cx >= panelW + radius || cy >= panelH + radius) continue;
          const [r, g, b] = STATE_RGB[s] ?? STATE_RGB[3]!;
          for (let dy = -radius; dy <= radius; dy++) {
            const yy = cy + dy;
            if (yy < 0 || yy >= panelH) continue;
            for (let dx = -radius; dx <= radius; dx++) {
              if (round && dx * dx + dy * dy > radius * radius + 1) continue;
              const xx = cx + dx;
              if (xx < 0 || xx >= panelW) continue;
              const o = (yy * totalW + ox + xx) * 4;
              const edge = round && dx * dx + dy * dy > (radius - 1) * (radius - 1) + 1;
              data[o] = edge ? r * 0.55 : r;
              data[o + 1] = edge ? g * 0.55 : g;
              data[o + 2] = edge ? b * 0.55 : b;
              data[o + 3] = 245;
            }
          }
        }
      });
      drawnRef.current = drawn;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(dotImage, 0, 0);

      const flashPhase = (now % 500) / 500;
      p.runs.forEach((run, index) => {
        const d = drawn[index];
        const view = p.scrubIndex === null ? run.latest.current : viewFor(run);
        const ox = index * (panelW + GAP_PX);
        ctx.save();
        ctx.beginPath();
        ctx.rect(ox, 0, panelW, panelH);
        ctx.clip();

        // Parking stall paint, once you are close enough to see it.
        if (net && z >= 7) {
          ctx.setTransform(1, 0, 0, 1, ox, 0);
          ctx.strokeStyle = 'rgba(220,226,235,0.16)';
          ctx.lineWidth = Math.max(1, m2px * 0.12);
          ctx.beginPath();
          for (let s = 0; s < net.stallX.length; s++) {
            const sx = toX(net.stallX[s]!);
            const sy = toY(net.stallY[s]!);
            if (sx < -40 || sy < -40 || sx > panelW + 40 || sy > panelH + 40) continue;
            const half = 1.35 * m2px;
            const depth = 2.75 * m2px;
            ctx.moveTo(sx - half, sy - depth);
            ctx.lineTo(sx - half, sy + depth);
          }
          ctx.stroke();
        }

        // Vehicles at their real size.
        const vf = d?.vehicles;
        if (vf && d?.vx && d.vy && d.vh && p.showVehicles) {
          const sky = view?.frame.weather;
          const beams = darkSky(sky);
          const margin = 16 * m2px;
          const pickedVehicle = p.picked?.type === 'vehicle' && p.picked.run === index ? p.picked.vehicle : -1;
          for (let i = 0; i < vf.kind.length; i++) {
            const st = vf.state[i]!;
            if (st === VS.waiting || st === VS.gone) continue;
            const mx = d.vx[i]!;
            if (mx < 0) continue;
            const sx = toX(mx);
            const sy = toY(d.vy[i]!);
            if (sx < -margin || sy < -margin || sx > panelW + margin || sy > panelH + margin) continue;
            const kind = VEHICLE_KINDS[vf.kind[i]!]!;
            const dim = p.vehicleFocus !== null && p.vehicleFocus !== kind;
            ctx.setTransform(m2px, 0, 0, m2px, ox + sx, sy);
            ctx.rotate(d.vh[i]!);
            ctx.globalAlpha = dim ? 0.16 : st === VS.parked ? 0.88 : 1;
            const emergency = kind === 'police' || kind === 'ambulance';
            drawVehicle(ctx, {
              kind,
              index: i,
              scale: m2px,
              look: {
                braking: st === VS.stopped || (st !== VS.parked && vf.speed[i]! < 0.5),
                beams: beams && st !== VS.parked,
                flashing: emergency && (st === VS.responding || st === VS.on_scene || st === VS.stopped),
                flashPhase,
                parked: st === VS.parked,
              },
            });
            if (i === pickedVehicle) {
              const t = VEHICLE_TYPES[kind];
              ctx.globalAlpha = 1;
              ctx.strokeStyle = '#ffffff';
              ctx.lineWidth = Math.max(0.25, 2 / m2px);
              ctx.strokeRect(-t.lengthM / 2 - 1, -t.widthM / 2 - 1, t.lengthM + 2, t.widthM + 2);
            }
          }
          ctx.globalAlpha = 1;
        }

        // Officers: a blue disc with a white ring, a shield when close.
        ctx.setTransform(1, 0, 0, 1, ox, 0);
        if (view) {
          const r = Math.max(2.5, Math.min(9, 1.4 * m2px));
          for (const cell of view.frame.officerCells) {
            if (cell < 0) continue;
            const sx = toX(((cell % map.width) + 0.5) * CELL_SIZE_M);
            const sy = toY((Math.floor(cell / map.width) + 0.5) * CELL_SIZE_M);
            if (sx < -10 || sy < -10 || sx > panelW + 10 || sy > panelH + 10) continue;
            ctx.beginPath();
            ctx.arc(sx, sy, r, 0, Math.PI * 2);
            ctx.fillStyle = '#2f81f7';
            ctx.fill();
            ctx.lineWidth = Math.max(1, r * 0.3);
            ctx.strokeStyle = '#e6f0ff';
            ctx.stroke();
          }
        }

        // The picked fan.
        if (p.picked?.type === 'dot' && p.picked.run === index && d) {
          const i = p.picked.dot;
          if (d.x[i]! >= 0) {
            const sx = toX(d.x[i]!);
            const sy = toY(d.y[i]!);
            ctx.beginPath();
            ctx.arc(sx, sy, Math.max(6, radius * 3), 0, Math.PI * 2);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }

        // Scale bar and compass.
        const nice = [5, 10, 20, 50, 100, 200, 500];
        const meters = nice.find((m) => m * m2px >= 60) ?? 500;
        const bar = meters * m2px;
        const bx = panelW - bar - 14;
        const by = panelH - 14;
        ctx.fillStyle = 'rgba(5,7,10,0.55)';
        ctx.fillRect(bx - 6, by - 16, bar + 12, 22);
        ctx.strokeStyle = '#e6edf3';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bx, by - 4);
        ctx.lineTo(bx, by);
        ctx.lineTo(bx + bar, by);
        ctx.lineTo(bx + bar, by - 4);
        ctx.stroke();
        ctx.fillStyle = '#e6edf3';
        ctx.font = '600 11px ui-sans-serif, system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(`${meters} m`, bx + bar / 2, by - 6);
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(230,237,243,0.75)';
        ctx.beginPath();
        ctx.moveTo(panelW - 20, 12);
        ctx.lineTo(panelW - 15, 26);
        ctx.lineTo(panelW - 25, 26);
        ctx.closePath();
        ctx.fill();
        ctx.fillText('N', panelW - 24, 39);
        ctx.restore();
      });
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [map, net, PX, panelW, panelH, totalW, clampView, viewFor]);

  // ─── input: wheel zoom, drag pan, click to inspect ───
  const toCanvas = (event: { clientX: number; clientY: number }, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const k = totalW / rect.width;
    const px = (event.clientX - rect.left) * k;
    const py = (event.clientY - rect.top) * k;
    const index = Math.min(2, Math.max(0, Math.floor(px / (panelW + GAP_PX))));
    return { px, py, index, lx: px - index * (panelW + GAP_PX), k };
  };

  const stackRef = useRef<HTMLDivElement>(null);
  const onWheel = (event: WheelEvent) => {
    const el = stackRef.current;
    if (!el) return;
    // Native and non-passive, so the page does not scroll under a zooming map.
    event.preventDefault();
    if ((event.target as HTMLElement).closest('.zoom-controls')) return;
    const { lx, py } = toCanvas(event, el);
    const v = flyRef.current ? flyRef.current.to : viewRef.current;
    flyRef.current = null;
    const factor = Math.exp(-event.deltaY * 0.0022);
    const z = Math.min(MAX_ZOOM, Math.max(1, v.z * factor));
    // Keep the point under the cursor where it is.
    const wx = (lx - panelW / 2) / v.z + v.cx;
    const wy = (py - panelH / 2) / v.z + v.cy;
    setView({ z, cx: wx - (lx - panelW / 2) / z, cy: wy - (py - panelH / 2) / z });
  };

  const wheelRef = useRef(onWheel);
  wheelRef.current = onWheel;
  useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // For unattended checks, like window.gameday: point the camera from a script.
  useEffect(() => {
    (window as unknown as { gamedayMap?: unknown }).gamedayMap = {
      lookAt: (xM: number, yM: number, z: number) =>
        setView({ z, cx: (xM * PX) / CELL_SIZE_M, cy: (yM * PX) / CELL_SIZE_M }),
      view: () => ({ ...viewRef.current }),
    };
  }, [PX, setView]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, cx: viewRef.current.cx, cy: viewRef.current.cy, moved: false };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const k = totalW / rect.width;
    const dx = (event.clientX - drag.x) * k;
    const dy = (event.clientY - drag.y) * k;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    flyRef.current = null;
    const z = viewRef.current.z;
    setView({ z, cx: drag.cx - dx / z, cy: drag.cy - dy / z });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.moved || !onPick) return;
    const { lx, py, index, k } = toCanvas(event, event.currentTarget);
    if (lx > panelW) return;
    const v = viewRef.current;
    const m2px = (v.z * PX) / CELL_SIZE_M;
    const mx = (((lx - panelW / 2) / v.z + v.cx) * CELL_SIZE_M) / PX;
    const my = (((py - panelH / 2) / v.z + v.cy) * CELL_SIZE_M) / PX;
    const d = drawnRef.current[index];
    if (!d) return;

    // A vehicle under the cursor wins: test the point in the vehicle's own frame.
    if (d.vehicles && d.vx && d.vy && d.vh && showVehicles) {
      const slack = Math.max(0.8, (6 * k) / m2px);
      let best = -1;
      let bestArea = Infinity;
      for (let i = 0; i < d.vehicles.kind.length; i++) {
        const x = d.vx[i]!;
        if (x < 0) continue;
        const t = VEHICLE_TYPES[VEHICLE_KINDS[d.vehicles.kind[i]!]!];
        const dx = mx - x;
        const dy = my - d.vy[i]!;
        if (Math.abs(dx) > 20 || Math.abs(dy) > 20) continue;
        const c = Math.cos(-d.vh[i]!);
        const s = Math.sin(-d.vh[i]!);
        const ax = dx * c - dy * s;
        const ay = dx * s + dy * c;
        if (Math.abs(ax) <= t.lengthM / 2 + slack && Math.abs(ay) <= t.widthM / 2 + slack) {
          const area = t.lengthM * t.widthM;
          if (area < bestArea) {
            bestArea = area;
            best = i;
          }
        }
      }
      if (best >= 0) {
        onPick({ type: 'vehicle', run: index, vehicle: best });
        return;
      }
    }

    const reach = Math.max(2.5, (9 * k) / m2px);
    let best = -1;
    let bestSq = reach * reach;
    const gone = DOT_STATES.length - 1;
    for (let i = 0; i < d.x.length; i++) {
      if (d.x[i]! < 0 || d.state[i] === gone) continue;
      const dx = d.x[i]! - mx;
      const dy = d.y[i]! - my;
      const sq = dx * dx + dy * dy;
      if (sq < bestSq) {
        bestSq = sq;
        best = i;
      }
    }
    if (best >= 0) {
      onPick({ type: 'dot', run: index, dot: best });
      return;
    }

    // Otherwise, the heat colour under the cursor.
    const cell = Math.floor(my / CELL_SIZE_M) * map.width + Math.floor(mx / CELL_SIZE_M);
    const density = (scrubIndex === null ? runs[index]?.latest.current : viewFor(runs[index]!))?.density?.peoplePerM2[cell] ?? 0;
    const band = bandOf(density, bands);
    onPick(band >= 0 ? { type: 'cell', run: index, cell, band, density } : null);
  };

  // ─── per-panel readouts ───
  const readouts = useMemo(
    () => runs.map((run) => readoutOf(viewFor(run)?.frame)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ticks, scrubIndex, runs, viewFor],
  );

  const weathers = readouts.map((r) => r.weather);
  const z = viewRef.current.z;
  const columns = `${panelW}fr ${GAP_PX}fr ${panelW}fr ${GAP_PX}fr ${panelW}fr`;
  void viewTick;

  const zoomBy = (factor: number) => {
    const v = flyRef.current ? flyRef.current.to : viewRef.current;
    flyTo({ ...v, z: v.z * factor }, 280);
  };
  const incidentBox = () => {
    if (!incidentCells || incidentCells.length === 0) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of incidentCells) {
      const x = c % map.width;
      const y = Math.floor(c / map.width);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const w = (x1 - x0 + 1) * PX;
    const h = (y1 - y0 + 1) * PX;
    flyTo({ z: Math.max(1, Math.min(panelW / (w * 1.5 + 20), panelH / (h * 1.5 + 20))), cx: ((x0 + x1 + 1) / 2) * PX, cy: ((y0 + y1 + 1) / 2) * PX });
  };
  const stadiumBox = () => {
    const bowl = map.places.find((p) => p.kind === 'seating');
    if (!bowl) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of bowl.cells) {
      const x = c % map.width;
      const y = Math.floor(c / map.width);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    flyTo({ z: Math.min(panelW / ((x1 - x0) * PX * 1.4), panelH / ((y1 - y0) * PX * 1.4)), cx: ((x0 + x1) / 2) * PX, cy: ((y0 + y1) / 2) * PX });
  };

  return (
    <div
      ref={stackRef}
      className="maps-stack"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={(e) => {
        const { lx, py } = toCanvas(e, e.currentTarget);
        const v = viewRef.current;
        const wx = (lx - panelW / 2) / v.z + v.cx;
        const wy = (py - panelH / 2) / v.z + v.cy;
        flyTo({ z: v.z * 2.5, cx: wx, cy: wy }, 380);
      }}
      style={{ aspectRatio: `${totalW} / ${panelH}` }}
    >
      <canvas ref={pixiRef} className="compare-canvas layer" />
      <canvas ref={liveRef} className="compare-canvas layer live" />
      <WeatherFx weathers={weathers} panelW={panelW} panelH={panelH} gap={GAP_PX} totalW={totalW} />
      <div className="hud" style={{ gridTemplateColumns: columns }}>
        {readouts.map((r, i) => (
          <div key={i} className="hud-panel" style={{ gridColumn: i * 2 + 1 }}>
            <ReadoutChips readout={r} />
          </div>
        ))}
      </div>
      <div
        className="zoom-controls"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button onClick={() => zoomBy(1.8)} title="Zoom in">＋</button>
        <button onClick={() => zoomBy(1 / 1.8)} title="Zoom out">－</button>
        <button onClick={() => flyTo(fit)} title="Whole map">Fit</button>
        <button onClick={stadiumBox} title="Zoom to the stadium">Stadium</button>
        <button onClick={incidentBox} title="Zoom to the incident zone" disabled={!incidentCells?.length}>Incident</button>
        <span className="zoom-level">{z >= 10 ? Math.round(z) : z.toFixed(1)}×</span>
      </div>
    </div>
  );
}
