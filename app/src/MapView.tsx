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

const CELL_COLORS: Record<CellKind, string> = {
  blocked: '#1b222b',
  walk: '#2b3340',
  road: '#333c49',
  stands: '#3a2b2b',
  concourse: '#2e3a44',
  shelter: '#2c4038',
  parking: '#262b33',
};

/** Dot colour by DotState, in the contract's own order. */
const STATE_COLORS = [0x7aa2f7, 0xbb9af7, 0xe0af68, 0x9ece6a, 0x7dcfff, 0xf7768e, 0xc0caf5, 0x000000];

function paintBase(map: MapBundle): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = map.width;
  canvas.height = map.height;
  const ctx = canvas.getContext('2d')!;
  for (let i = 0; i < map.cells.length; i++) {
    ctx.fillStyle = CELL_COLORS[map.cells[i]!];
    ctx.fillRect(i % map.width, Math.floor(i / map.width), 1, 1);
  }
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
  const heatRef = useRef<{ canvas: HTMLCanvasElement; texture: Texture } | null>(null);
  const dotsRef = useRef<Graphics | null>(null);
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
        const heatTexture = Texture.from(heatCanvas);
        heatTexture.source.scaleMode = 'nearest';
        const heat = new Sprite(heatTexture);
        heat.setSize(map.width * PX_PER_CELL, map.height * PX_PER_CELL);
        heat.alpha = 0.85;
        app.stage.addChild(heat);
        heatRef.current = { canvas: heatCanvas, texture: heatTexture };

        const zone = new Graphics();
        const dots = new Graphics();
        const officers = new Graphics();
        app.stage.addChild(zone, dots, officers);
        zoneRef.current = zone;
        dotsRef.current = dots;
        officersRef.current = officers;
        appRef.current = app;
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
      const image = ctx.createImageData(heat.canvas.width, heat.canvas.height);
      const { peoplePerM2 } = view.density;
      for (let i = 0; i < peoplePerM2.length; i++) {
        const ratio = Math.min(peoplePerM2[i]! / dangerDensity, 1.5);
        if (ratio <= 0.02) continue;
        const o = i * 4;
        image.data[o] = Math.min(255, 90 + ratio * 165);
        image.data[o + 1] = Math.max(0, 180 - ratio * 170);
        image.data[o + 2] = 40;
        image.data[o + 3] = Math.min(230, ratio * 190);
      }
      ctx.putImageData(image, 0, 0);
      heat.texture.source.update();
    }

    const scale = PX_PER_CELL / CELL_SIZE_M;
    const dotSize = Math.max(1.5, PX_PER_CELL * 0.8);
    dots.clear();
    const { x, y, state } = view.frame;
    for (let s = 0; s < DOT_STATES.length - 1; s++) {
      let drew = false;
      for (let i = 0; i < x.length; i++) {
        if (state[i] !== s) continue;
        dots.rect(x[i]! * scale - dotSize / 2, y[i]! * scale - dotSize / 2, dotSize, dotSize);
        drew = true;
      }
      if (drew) dots.fill({ color: STATE_COLORS[s]!, alpha: 0.95 });
    }

    officers.clear();
    const badge = Math.max(4, PX_PER_CELL);
    for (const cell of view.frame.officerCells) {
      if (cell < 0) continue;
      const cx = (cell % map.width) * PX_PER_CELL;
      const cy = Math.floor(cell / map.width) * PX_PER_CELL;
      officers.rect(cx - badge / 2, cy - badge / 2, badge, badge);
    }
    officers.stroke({ color: 0x58a6ff, width: 1.5 });
    // The incident zone, outlined once per redraw so it reads over the heatmap.
    const zone = zoneRef.current;
    if (zone) {
      zone.clear();
      if (incidentCells && incidentCells.length > 0) {
        for (const cell of incidentCells) {
          const cx = (cell % map.width) * PX_PER_CELL;
          const cy = Math.floor(cell / map.width) * PX_PER_CELL;
          zone.rect(cx, cy, PX_PER_CELL, PX_PER_CELL);
        }
        zone.stroke({ color: 0xffd166, width: 1, alpha: 0.5 });
      }
    }
  }, [tick, latest, frames, scrubIndex, map, dangerDensity, PX_PER_CELL, incidentCells]);

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
