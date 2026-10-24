import { useEffect, useRef, useState } from 'react';
import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { CellKind, MapBundle } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_STATES } from '../../contracts.ts';
import { STATE_RGB } from './people.ts';
import type { RunHandle } from './useRun.ts';

/**
 * All three runs in ONE PixiJS Application.
 *
 * Three Applications meant three WebGL contexts, and `Application.init` is not
 * cheap: Pixi probes the GPU by compiling shaders in a loop to find its `if`
 * limit. Paying that once instead of three times, and sharing the base map
 * texture across the panels, is the difference between the page appearing to
 * hang and appearing instantly on a modest GPU.
 */
const TARGET_PANEL_PX = 760;
const GAP_PX = 10;

const pxPerCell = (map: MapBundle) => Math.max(1, Math.round(TARGET_PANEL_PX / map.width));

const RGB: Record<CellKind, [number, number, number]> = {
  blocked: [0x1b, 0x22, 0x2b],
  walk: [0x2b, 0x33, 0x40],
  road: [0x33, 0x3c, 0x49],
  stands: [0x3a, 0x2b, 0x2b],
  concourse: [0x2e, 0x3a, 0x44],
  shelter: [0x2c, 0x40, 0x38],
  parking: [0x26, 0x2b, 0x33],
};

/** The static map as pixel bytes — never one fillRect per cell. */
function paintBase(map: MapBundle): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = map.width;
  canvas.height = map.height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(map.width, map.height);
  const data = image.data;
  for (let i = 0; i < map.cells.length; i++) {
    const [r, g, b] = RGB[map.cells[i]!];
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
  heat: Layer;
  dots: Layer;
  zone: Graphics;
  officers: Graphics;
}

function makeLayer(width: number, height: number): Layer {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  return { canvas, texture, image };
}

export interface ComparisonMapsProps {
  map: MapBundle;
  runs: RunHandle[];
  /** Replay frame to draw, or null to follow the live runs. */
  scrubIndex: number | null;
  dangerDensity: number;
  incidentCells?: number[];
  onPickDot?: (run: number, dot: number) => void;
}

export function ComparisonMaps({ map, runs, scrubIndex, dangerDensity, incidentCells, onPickDot }: ComparisonMapsProps) {
  const PX = pxPerCell(map);
  const panelW = map.width * PX;
  const panelH = map.height * PX;
  const totalW = panelW * 3 + GAP_PX * 2;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<Application | null>(null);
  const panelsRef = useRef<Panel[]>([]);
  const shownRef = useRef<(RunHandle['latest']['current'])[]>([]);
  // Bumped once the Application is up, so a remount (switching back from the
  // close-up while paused) draws the current frame instead of waiting for one.
  const [ready, setReady] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    const app = new Application();

    // React 18 StrictMode mounts effects twice in development. Destroying the
    // first Application from inside its own init promise tore down WebGL state
    // the second one was still setting up, and the second init never resolved —
    // the page simply stopped, mid-setup, before drawing anything. So the
    // promise is kept and the teardown waits for it to settle instead.
    const ready = app
      .init({ canvas, width: totalW, height: panelH, background: 0x05070a, antialias: false })
      .then(() => {
        if (disposed) return;
        // One base texture, shared by all three panels.
        const baseTexture = Texture.from(paintBase(map));
        baseTexture.source.scaleMode = 'nearest';

        const panels: Panel[] = [];
        for (let i = 0; i < 3; i++) {
          const group = new Container();
          group.x = i * (panelW + GAP_PX);

          const base = new Sprite(baseTexture);
          base.setSize(panelW, panelH);

          const heat = makeLayer(map.width, map.height);
          const heatSprite = new Sprite(heat.texture);
          heatSprite.setSize(panelW, panelH);
          heatSprite.alpha = 0.85;

          const dots = makeLayer(panelW, panelH);
          const dotSprite = new Sprite(dots.texture);

          const zone = new Graphics();
          const officers = new Graphics();
          group.addChild(base, heatSprite, dotSprite, zone, officers);
          app.stage.addChild(group);
          panels.push({ heat, dots, zone, officers });
        }

        panelsRef.current = panels;
        appRef.current = app;
        // Render on demand: frames arrive every 15 sim seconds, so a running
        // ticker would redraw an unchanged scene sixty times a second.
        app.ticker.stop();
        app.render();
        setReady((n) => n + 1);
      });

    return () => {
      disposed = true;
      panelsRef.current = [];
      appRef.current = null;
      void ready.catch(() => {}).then(() => {
        app.destroy(true);
      });
    };
  }, [map, panelW, panelH, totalW, PX]);

  const ticks = runs.map((r) => r.tick).join(',');

  useEffect(() => {
    const app = appRef.current;
    const panels = panelsRef.current;
    if (!app || panels.length < 3) return;

    const scale = PX / CELL_SIZE_M;
    const gone = DOT_STATES.length - 1;
    const radius = PX >= 8 ? 2 : PX >= 3 ? 1 : 0;
    shownRef.current = [];

    runs.forEach((run, index) => {
      const panel = panels[index]!;
      const kept = run.frames.current ?? [];
      const view = scrubIndex === null ? run.latest.current : (kept[Math.min(scrubIndex, kept.length - 1)] ?? run.latest.current);
      shownRef.current[index] = view ?? null;
      if (!view) return;

      if (view.density) {
        const data = panel.heat.image.data;
        data.fill(0);
        const { peoplePerM2 } = view.density;
        for (let i = 0; i < peoplePerM2.length; i++) {
          const value = peoplePerM2[i]!;
          if (value <= 0.08) continue;
          const ratio = Math.min(value / dangerDensity, 1.5);
          const o = i * 4;
          data[o] = Math.min(255, 90 + ratio * 165);
          data[o + 1] = Math.max(0, 180 - ratio * 170);
          data[o + 2] = 40;
          data[o + 3] = Math.min(230, ratio * 190);
        }
        panel.heat.canvas.getContext('2d')!.putImageData(panel.heat.image, 0, 0);
        panel.heat.texture.source.update();
      }

      const data = panel.dots.image.data;
      data.fill(0);
      const { x, y, state } = view.frame;
      for (let i = 0; i < x.length; i++) {
        const s = state[i]!;
        if (s === gone) continue;
        const px = x[i]!;
        if (px < 0) continue; // not arrived yet
        const cx = (px * scale) | 0;
        const cy = (y[i]! * scale) | 0;
        const [r, g, b] = STATE_RGB[s] ?? STATE_RGB[3]!;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = cy + dy;
          if (yy < 0 || yy >= panelH) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = cx + dx;
            if (xx < 0 || xx >= panelW) continue;
            const o = (yy * panelW + xx) * 4;
            data[o] = r;
            data[o + 1] = g;
            data[o + 2] = b;
            data[o + 3] = 242;
          }
        }
      }
      panel.dots.canvas.getContext('2d')!.putImageData(panel.dots.image, 0, 0);
      panel.dots.texture.source.update();

      panel.officers.clear();
      const badge = Math.max(4, PX);
      for (const cell of view.frame.officerCells) {
        if (cell < 0) continue;
        const ox = (cell % map.width) * PX;
        const oy = Math.floor(cell / map.width) * PX;
        panel.officers.rect(ox - badge / 2, oy - badge / 2, badge, badge);
      }
      panel.officers.stroke({ color: 0x58a6ff, width: 1.5 });
    });

    app.render();
  }, [ticks, scrubIndex, runs, map, dangerDensity, PX, panelW, panelH, ready]);

  // The incident zone never moves, so it is drawn only when it changes.
  useEffect(() => {
    const panels = panelsRef.current;
    if (panels.length < 3) return;
    for (const panel of panels) {
      panel.zone.clear();
      if (!incidentCells || incidentCells.length === 0) continue;
      for (const cell of incidentCells) {
        const cx = (cell % map.width) * PX;
        const cy = Math.floor(cell / map.width) * PX;
        panel.zone.rect(cx, cy, PX, PX);
      }
      panel.zone.stroke({ color: 0xffd166, width: 1, alpha: 0.45 });
    }
    appRef.current?.render();
  }, [incidentCells, map, PX, ticks, ready]);

  /** Click anywhere to pick the nearest dot in whichever panel was clicked. */
  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onPickDot) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = totalW / rect.width;
    const px = (event.clientX - rect.left) * scale;
    const py = (event.clientY - rect.top) * scale;

    const index = Math.min(2, Math.max(0, Math.floor(px / (panelW + GAP_PX))));
    const localX = px - index * (panelW + GAP_PX);
    const view = shownRef.current[index];
    if (!view) return;

    const mx = (localX / PX) * CELL_SIZE_M;
    const my = (py / PX) * CELL_SIZE_M;
    const { x, y, state } = view.frame;
    const gone = DOT_STATES.length - 1;
    let best = -1;
    let bestSq = Infinity;
    for (let i = 0; i < x.length; i++) {
      if (x[i]! < 0 || state[i] === gone) continue;
      const dx = x[i]! - mx;
      const dy = y[i]! - my;
      const sq = dx * dx + dy * dy;
      if (sq < bestSq) {
        bestSq = sq;
        best = i;
      }
    }
    // Only a pick if they clicked within about 12 m of a dot.
    if (best >= 0 && bestSq < 144) onPickDot(index, best);
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      className="compare-canvas"
      style={{ cursor: onPickDot ? 'crosshair' : 'default' }}
    />
  );
}
