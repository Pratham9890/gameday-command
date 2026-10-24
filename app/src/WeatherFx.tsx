import { useEffect, useRef } from 'react';
import type { WeatherState } from '../../contracts.ts';

/**
 * Animated weather over the three maps: rain and snow blown by the wind, fog
 * drifting off the river, lightning flashes and bolts, a heat shimmer.
 *
 * It is a plain 2D canvas on top of the PixiJS one with pointer events off, and
 * it animates on its own clock rather than the simulation's: frames arrive every
 * 15 sim seconds, and rain that moved once every second of wall time would look
 * like static. When the sky is clear in every panel the loop stops entirely.
 */

interface Drop { x: number; y: number; len: number; speed: number }
interface Flake { x: number; y: number; r: number; drift: number; phase: number; speed: number }
interface Blob { x: number; y: number; r: number; speed: number }
interface Flash { next: number; alpha: number; bolt: { x: number; y: number }[] | null; second: number }

interface PanelFx {
  drops: Drop[];
  flakes: Flake[];
  blobs: Blob[];
  flash: Flash;
}

export interface WeatherFxProps {
  weathers: (WeatherState | undefined)[];
  /** Layout of the panels in the underlying canvas, in its pixels. */
  panelW: number;
  panelH: number;
  gap: number;
  totalW: number;
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function boltPath(w: number, h: number): { x: number; y: number }[] {
  const points = [{ x: w * (0.15 + Math.random() * 0.7), y: 0 }];
  const end = h * (0.45 + Math.random() * 0.5);
  while (points[points.length - 1]!.y < end) {
    const last = points[points.length - 1]!;
    points.push({ x: last.x + (Math.random() - 0.5) * w * 0.09, y: last.y + h * (0.03 + Math.random() * 0.05) });
  }
  return points;
}

export function WeatherFx({ weathers, panelW, panelH, gap, totalW }: WeatherFxProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const weatherRef = useRef(weathers);
  weatherRef.current = weathers;
  const fxRef = useRef<PanelFx[]>([]);
  const rafRef = useRef<number | null>(null);

  const anyWeather = weathers.some((w) => w && (w.kind !== 'clear' || w.lightning));
  const signature = weathers.map((w) => (w ? `${w.kind}:${w.intensity}:${w.lightning}` : '-')).join('|');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const still = reducedMotion();

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const k = canvas.width / totalW;
      const pw = panelW * k;
      const ph = panelH * k;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let active = false;

      weatherRef.current.forEach((w, index) => {
        if (!w) return;
        const ox = index * (panelW + gap) * k;
        let fx = fxRef.current[index];
        if (!fx) {
          fx = { drops: [], flakes: [], blobs: [], flash: { next: now + 1500 + Math.random() * 3000, alpha: 0, bolt: null, second: 0 } };
          fxRef.current[index] = fx;
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(ox, 0, pw, ph);
        ctx.clip();
        ctx.translate(ox, 0);

        const I = w.intensity;
        // Where the wind is blowing TO, on screen (y grows south).
        const toward = ((w.windFromDeg + 180) * Math.PI) / 180;
        const wx = Math.sin(toward);
        const wy = -Math.cos(toward);
        const gust = Math.min(1, w.windMps / 14);

        // Sky tint first: storms darken, snow brightens, heat warms.
        const tint =
          w.kind === 'thunderstorm' ? `rgba(4,8,22,${0.1 + 0.12 * I})` :
          w.kind === 'heavy_rain' ? `rgba(6,12,26,${0.07 + 0.1 * I})` :
          w.kind === 'rain' ? `rgba(8,14,28,${0.08 + 0.1 * I})` :
          w.kind === 'overcast' ? `rgba(12,16,24,${0.1 + 0.12 * I})` :
          w.kind === 'snow' ? `rgba(225,235,250,${0.04 + 0.06 * I})` :
          w.kind === 'fog' ? `rgba(196,204,212,${0.08 + 0.14 * I})` :
          w.kind === 'heat' ? `rgba(255,120,30,${0.04 + 0.06 * I})` : null;
        if (tint) {
          ctx.fillStyle = tint;
          ctx.fillRect(0, 0, pw, ph);
        }

        const wet = w.kind === 'rain' || w.kind === 'heavy_rain' || w.kind === 'thunderstorm';
        if (wet) {
          active = true;
          const want = Math.round(((pw * ph) / 3200) * (0.3 + I));
          while (fx.drops.length < want) {
            fx.drops.push({ x: Math.random() * pw, y: Math.random() * ph, len: (6 + Math.random() * 10) * k, speed: (500 + Math.random() * 500) * k });
          }
          fx.drops.length = Math.min(fx.drops.length, want);
          const dx = wx * (0.35 + gust) ;
          const dy = 1 + wy * 0.2;
          const norm = Math.hypot(dx, dy) || 1;
          const ux = dx / norm;
          const uy = dy / norm;
          ctx.strokeStyle = `rgba(170,200,235,${0.18 + 0.16 * I})`;
          ctx.lineWidth = Math.max(1, 0.9 * k);
          ctx.beginPath();
          for (const d of fx.drops) {
            if (!still) {
              d.x += ux * d.speed * dt;
              d.y += uy * d.speed * dt;
              if (d.y > ph + 20) { d.y = -20; d.x = Math.random() * pw; }
              if (d.x > pw + 20) d.x = -20;
              if (d.x < -20) d.x = pw + 20;
            }
            ctx.moveTo(d.x, d.y);
            ctx.lineTo(d.x - ux * d.len, d.y - uy * d.len);
          }
          ctx.stroke();
          // Splashes: a few rings where drops land.
          if (!still) {
            ctx.strokeStyle = `rgba(170,200,235,${0.12 + 0.15 * I})`;
            ctx.beginPath();
            for (let s = 0; s < 6 * I; s++) {
              const x = Math.random() * pw;
              const y = Math.random() * ph;
              const r = (1.5 + Math.random() * 3) * k;
              ctx.moveTo(x + r, y);
              ctx.arc(x, y, r, 0, Math.PI * 2);
            }
            ctx.stroke();
          }
        }

        if (w.kind === 'snow') {
          active = true;
          const want = Math.round(((pw * ph) / 4200) * (0.3 + I));
          while (fx.flakes.length < want) {
            fx.flakes.push({ x: Math.random() * pw, y: Math.random() * ph, r: (0.8 + Math.random() * 1.6) * k, drift: Math.random() * 2 - 1, phase: Math.random() * 6, speed: (25 + Math.random() * 45) * k });
          }
          fx.flakes.length = Math.min(fx.flakes.length, want);
          ctx.fillStyle = 'rgba(245,248,255,0.7)';
          ctx.beginPath();
          for (const f of fx.flakes) {
            if (!still) {
              f.phase += dt * 1.5;
              f.x += (wx * 30 * gust * k + Math.sin(f.phase) * 12 * k * f.drift) * dt;
              f.y += f.speed * dt;
              if (f.y > ph + 5) { f.y = -5; f.x = Math.random() * pw; }
              if (f.x > pw + 5) f.x = -5;
              if (f.x < -5) f.x = pw + 5;
            }
            ctx.moveTo(f.x + f.r, f.y);
            ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
          }
          ctx.fill();
        }

        if (w.kind === 'fog') {
          active = true;
          while (fx.blobs.length < 9) {
            fx.blobs.push({ x: Math.random() * pw, y: Math.random() * ph, r: (120 + Math.random() * 180) * k, speed: (4 + Math.random() * 8) * k });
          }
          for (const b of fx.blobs) {
            if (!still) {
              b.x += (wx || 1) * b.speed * dt;
              if (b.x - b.r > pw) b.x = -b.r;
              if (b.x + b.r < 0) b.x = pw + b.r;
            }
            const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
            g.addColorStop(0, `rgba(210,216,222,${0.12 * I})`);
            g.addColorStop(1, 'rgba(210,216,222,0)');
            ctx.fillStyle = g;
            ctx.fillRect(b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
          }
        }

        if (w.kind === 'heat' && !still) {
          active = true;
          ctx.strokeStyle = `rgba(255,190,120,${0.05 * I})`;
          ctx.lineWidth = 2 * k;
          ctx.beginPath();
          const t = now / 1000;
          for (let row = 0; row < 14; row++) {
            const y = (row / 14) * ph + Math.sin(t + row) * 6 * k;
            ctx.moveTo(0, y);
            for (let x = 0; x <= pw; x += 24 * k) ctx.lineTo(x, y + Math.sin(x / (30 * k) + t * 2 + row) * 3 * k);
          }
          ctx.stroke();
        }

        if (w.lightning) {
          active = true;
          const f = fx.flash;
          if (!still && now >= f.next) {
            f.alpha = 0.55 + Math.random() * 0.3;
            f.bolt = Math.random() < 0.7 ? boltPath(pw, ph) : null;
            f.second = now + 90 + Math.random() * 90;
            f.next = now + 2200 + Math.random() * 5200;
          }
          if (f.second && now >= f.second) {
            // The flicker: lightning nearly always flashes twice.
            f.alpha = Math.max(f.alpha, 0.35);
            f.second = 0;
          }
          if (f.alpha > 0.01) {
            ctx.fillStyle = `rgba(225,232,255,${f.alpha * 0.3})`;
            ctx.fillRect(0, 0, pw, ph);
            if (f.bolt && f.alpha > 0.2) {
              ctx.strokeStyle = `rgba(240,245,255,${Math.min(1, f.alpha * 1.6)})`;
              ctx.shadowColor = 'rgba(160,180,255,0.9)';
              ctx.shadowBlur = 14 * k;
              ctx.lineWidth = 2.2 * k;
              ctx.beginPath();
              f.bolt.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
              ctx.stroke();
              ctx.shadowBlur = 0;
            }
            f.alpha *= Math.pow(0.02, dt);
          }
        }
        ctx.restore();
      });

      rafRef.current = active && !still ? requestAnimationFrame(frame) : null;
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      observer.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [signature, anyWeather, panelW, panelH, gap, totalW]);

  return <canvas ref={canvasRef} className="weather-fx" aria-hidden="true" />;
}
