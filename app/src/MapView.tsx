import { useEffect, useRef } from 'react';
import { Application, Graphics, Sprite, Texture } from 'pixi.js';
import type { CellKind, MapBundle } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_STATES } from '../../contracts.ts';
import type { RunSnapshotView } from './useRun.ts';

const PX_PER_CELL = 18;

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
  /** Changes whenever a new frame arrives. */
  tick: number;
  dangerDensity: number;
}

/**
 * Density heatmap under dots, both at one pixel per 2 m cell and scaled up, so
 * the whole redraw is one texture upload plus a handful of batched fills.
 */
export function MapView({ map, latest, tick, dangerDensity }: MapViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<Application | null>(null);
  const heatRef = useRef<{ canvas: HTMLCanvasElement; texture: Texture } | null>(null);
  const dotsRef = useRef<Graphics | null>(null);
  const officersRef = useRef<Graphics | null>(null);

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

        const dots = new Graphics();
        const officers = new Graphics();
        app.stage.addChild(dots, officers);
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
    };
  }, [map]);

  useEffect(() => {
    const app = appRef.current;
    const view = latest.current;
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
    dots.clear();
    const { x, y, state } = view.frame;
    for (let s = 0; s < DOT_STATES.length - 1; s++) {
      let drew = false;
      for (let i = 0; i < x.length; i++) {
        if (state[i] !== s) continue;
        dots.rect(x[i]! * scale - 1, y[i]! * scale - 1, 2.5, 2.5);
        drew = true;
      }
      if (drew) dots.fill({ color: STATE_COLORS[s]!, alpha: 0.95 });
    }

    officers.clear();
    for (const cell of view.frame.officerCells) {
      if (cell < 0) continue;
      const cx = (cell % map.width) * PX_PER_CELL;
      const cy = Math.floor(cell / map.width) * PX_PER_CELL;
      officers.rect(cx + 3, cy + 3, PX_PER_CELL - 6, PX_PER_CELL - 6);
    }
    officers.stroke({ color: 0x58a6ff, width: 1.5 });
  }, [tick, latest, map, dangerDensity]);

  return <canvas ref={canvasRef} />;
}
