import { useEffect, useRef } from 'react';
import { Application, Graphics, Sprite, Texture } from 'pixi.js';
import type { CellKind, MapBundle } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_STATES } from '../../contracts.ts';
import type { RunSnapshotView } from './useRun.ts';

/**
 * Canvas pixels per 2 m cell, aimed at an ~800 px canvas whatever the map size:
 * 40 for the tiny test map, 1 for the stadium's 800 cell grid. CSS scales the
 * canvas down to the panel, so three runs fit side by side either way.
 */
const TARGET_CANVAS_PX = 800;
const pxPerCell = (map: MapBundle) => Math.max(1, Math.round(TARGET_CANVAS_PX / map.width));

/** Dot colour by DotState, in the contract's own order. The last state is 'gone'. */
const STATE_RGB: [number, number, number][] = [
  [0x7a, 0xa2, 0xf7], // arriving
  [0xbb, 0x9a, 0xf7], // tailgating
  [0xe0, 0xaf, 0x68], // queued
  [0x9e, 0xce, 0x6a], // walking
  [0x7d, 0xcf, 0xff], // seated
  [0xf7, 0x76, 0x8e], // sheltering
  [0xc0, 0xca, 0xf5], // leaving
  [0x00, 0x00, 0x00], // gone, never drawn
];

const RGB: Record<CellKind, [number, number, number]> = {
  blocked: [0x1b, 0x22, 0x2b],
  walk: [0x2b, 0x33, 0x40],
  road: [0x33, 0x3c, 0x49],
  stands: [0x3a, 0x2b, 0x2b],
  concourse: [0x2e, 0x3a, 0x44],
  shelter: [0x2c, 0x40, 0x38],
  parking: [0x26, 0x2b, 0x33],
};

/**
 * The static map, written straight into pixel bytes.
 *
 * This used to be one fillRect per cell. On the stadium map that is 640,000
 * canvas calls per view and three views on screen, which pegged the renderer
 * hard enough that Chrome could not even answer a DevTools request — the page
 * looked like it had hung, because it had.
 */
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

export interface MapViewProps {
  map: MapBundle;
  latest: React.RefObject<RunSnapshotView | null>;
  frames: React.RefObject<RunSnapshotView[]>;
  /** Changes whenever a new frame arrives. */
  tick: number;
  dangerDensity: number;
  /** Replay frame to draw, or null to follow the live run. */
  scrubIndex: number | null;
  /** Cells the incident covers, outlined on the map. */
  incidentCells?: number[];
  onPickDot?: (dot: number) => void;
}

/**
 * Density heatmap under dots, both at one pixel per 2 m cell and scaled up, so
 * the whole redraw is one texture upload plus a handful of batched fills.
 */
export function MapView({ map, latest, frames, tick, dangerDensity, scrubIndex, incidentCells, onPickDot }: MapViewProps) {
  const PX_PER_CELL = pxPerCell(map);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<Application | null>(null);
  const heatRef = useRef<{ canvas: HTMLCanvasElement; texture: Texture; image: ImageData } | null>(null);
  const dotsRef = useRef<{ canvas: HTMLCanvasElement; texture: Texture; image: ImageData } | null>(null);
  const officersRef = useRef<Graphics | null>(null);
  const zoneRef = useRef<Graphics | null>(null);
  const shownRef = useRef<RunSnapshotView | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    const app = new Application();

    void app
      .init({
        canvas,
        width: map.width * PX_PER_CELL,
        height: map.height * PX_PER_CELL,
        background: 0x05070a,
        antialias: false,
      })
      .then(() => {
        if (disposed) {
          app.destroy(true);
          return;
        }
        const baseTexture = Texture.from(paintBase(map));
        baseTexture.source.scaleMode = 'nearest';
        const base = new Sprite(baseTexture);
        base.setSize(map.width * PX_PER_CELL, map.height * PX_PER_CELL);
        app.stage.addChild(base);

        const heatCanvas = document.createElement('canvas');
        heatCanvas.width = map.width;
        heatCanvas.height = map.height;
        const heatImage = heatCanvas.getContext('2d')!.createImageData(map.width, map.height);
        const heatTexture = Texture.from(heatCanvas);
        heatTexture.source.scaleMode = 'nearest';
        const heat = new Sprite(heatTexture);
        heat.setSize(map.width * PX_PER_CELL, map.height * PX_PER_CELL);
        heat.alpha = 0.85;
        app.stage.addChild(heat);
        heatRef.current = { canvas: heatCanvas, texture: heatTexture, image: heatImage };

        // Dots are plotted as pixels, not Graphics. Twenty thousand rects per
        // view means Pixi tessellates 60,000 rects into triangles on the CPU
        // every redraw, which pegs the renderer; writing pixel bytes is one
        // pass over the dots and a single texture upload.
        const dotCanvas = document.createElement('canvas');
        dotCanvas.width = map.width * PX_PER_CELL;
        dotCanvas.height = map.height * PX_PER_CELL;
        const dotCtx = dotCanvas.getContext('2d')!;
        const dotImage = dotCtx.createImageData(dotCanvas.width, dotCanvas.height);
        const dotTexture = Texture.from(dotCanvas);
        const dotSprite = new Sprite(dotTexture);
        dotSprite.setSize(dotCanvas.width, dotCanvas.height);

        const zone = new Graphics();
        const officers = new Graphics();
        app.stage.addChild(zone, dotSprite, officers);
        zoneRef.current = zone;
        dotsRef.current = { canvas: dotCanvas, texture: dotTexture, image: dotImage };
        officersRef.current = officers;
        appRef.current = app;

        // Render on demand, not every animation frame. Frames arrive every 15
        // sim seconds, so a running ticker spent three WebGL canvases' worth of
        // work per frame redrawing something that had not changed — enough to
        // peg software GL completely and to waste real GPU for nothing.
        app.ticker.stop();
        app.render();
      });

    return () => {
      disposed = true;
      appRef.current?.destroy(true);
      appRef.current = null;
      heatRef.current = null;
      dotsRef.current = null;
      officersRef.current = null;
      zoneRef.current = null;
    };
  }, [map, PX_PER_CELL]);

  useEffect(() => {
    const app = appRef.current;
    const kept = frames.current ?? [];
    const view = scrubIndex === null ? latest.current : (kept[Math.min(scrubIndex, kept.length - 1)] ?? latest.current);
    shownRef.current = view;
    const dots = dotsRef.current;
    const officers = officersRef.current;
    const heat = heatRef.current;
    if (!app || !view || !dots || !officers) return;

    if (heat && view.density) {
      const ctx = heat.canvas.getContext('2d')!;
      const data = heat.image.data;
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
      ctx.putImageData(heat.image, 0, 0);
      heat.texture.source.update();
    }

    const scale = PX_PER_CELL / CELL_SIZE_M;
    const width = dots.canvas.width;
    const height = dots.canvas.height;
    const data = dots.image.data;
    data.fill(0);
    const radius = PX_PER_CELL >= 8 ? 2 : PX_PER_CELL >= 3 ? 1 : 0;
    const gone = DOT_STATES.length - 1;
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
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = cx + dx;
          if (xx < 0 || xx >= width) continue;
          const o = (yy * width + xx) * 4;
          data[o] = r;
          data[o + 1] = g;
          data[o + 2] = b;
          data[o + 3] = 242;
        }
      }
    }
    dots.canvas.getContext('2d')!.putImageData(dots.image, 0, 0);
    dots.texture.source.update();

    officers.clear();
    const badge = Math.max(4, PX_PER_CELL);
    for (const cell of view.frame.officerCells) {
      if (cell < 0) continue;
      const cx = (cell % map.width) * PX_PER_CELL;
      const cy = Math.floor(cell / map.width) * PX_PER_CELL;
      officers.rect(cx - badge / 2, cy - badge / 2, badge, badge);
    }
    officers.stroke({ color: 0x58a6ff, width: 1.5 });
    app.render();
  }, [tick, latest, frames, scrubIndex, map, dangerDensity, PX_PER_CELL]);

  // The incident zone never moves, so it is drawn when it changes rather than
  // on every frame. A lightning zone is the whole seating deck — nearly 10,000
  // cells — and redrawing that per frame is pure waste.
  useEffect(() => {
    const zone = zoneRef.current;
    if (!zone) return;
    zone.clear();
    if (!incidentCells || incidentCells.length === 0) return;
    for (const cell of incidentCells) {
      const cx = (cell % map.width) * PX_PER_CELL;
      const cy = Math.floor(cell / map.width) * PX_PER_CELL;
      zone.rect(cx, cy, PX_PER_CELL, PX_PER_CELL);
    }
    zone.stroke({ color: 0xffd166, width: 1, alpha: 0.45 });
    appRef.current?.render();
  }, [incidentCells, map, PX_PER_CELL, tick]);

  /** Click the map to pick the nearest dot, for the dot detail panel. */
  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const view = shownRef.current;
    if (!view || !onPickDot) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = (map.width * PX_PER_CELL) / rect.width;
    const px = (event.clientX - rect.left) * scale;
    const py = (event.clientY - rect.top) * scale;
    const mx = (px / PX_PER_CELL) * CELL_SIZE_M;
    const my = (py / PX_PER_CELL) * CELL_SIZE_M;

    const { x, y, state } = view.frame;
    let best = -1;
    let bestSq = Infinity;
    for (let i = 0; i < x.length; i++) {
      if (x[i]! < 0 || state[i] === DOT_STATES.length - 1) continue;
      const dx = x[i]! - mx;
      const dy = y[i]! - my;
      const sq = dx * dx + dy * dy;
      if (sq < bestSq) {
        bestSq = sq;
        best = i;
      }
    }
    // Only count it as a pick if they clicked within about 10 m of a dot.
    if (best >= 0 && bestSq < 100) onPickDot(best);
  };

  return <canvas ref={canvasRef} onClick={handleClick} style={{ cursor: onPickDot ? 'crosshair' : 'default' }} />;
}
