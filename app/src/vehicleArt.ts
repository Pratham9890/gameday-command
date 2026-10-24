import type { VehicleKind } from '../../contracts.ts';
import { VEHICLE_TYPES } from '../../world/src/vehicles.ts';

/**
 * Top-down vehicle drawings, in meters, nose pointing +x.
 *
 * Every vehicle is drawn at its real footprint, so a charter bus is visibly
 * almost three sedans long and an RV parked across five stalls looks like one.
 * Detail is added as the zoom allows: a coloured dash when a car is a couple
 * of pixels long, a body and windshield at mid zoom, and cabins, beds, roof
 * units, lamps and light bars when you are close enough to tell a pickup from
 * an SUV.
 */

/** Real-world paint mix: mostly white, black, grey and silver, and some Buckeye scarlet. */
const PAINT: [string, number][] = [
  ['#eef1f4', 22], ['#2a2f37', 18], ['#7c848e', 16], ['#b9c0c9', 14], ['#2f5fa8', 9],
  ['#b5322b', 7], ['#bb0000', 5], ['#3e6e57', 3], ['#c8b48d', 3], ['#5b3d7a', 1], ['#e07b2a', 2],
];
const PAINT_TOTAL = PAINT.reduce((s, [, w]) => s + w, 0);

export function paintFor(index: number): string {
  let h = (index * 2654435761) >>> 0;
  h ^= h >>> 15;
  let roll = h % PAINT_TOTAL;
  for (const [colour, weight] of PAINT) {
    roll -= weight;
    if (roll < 0) return colour;
  }
  return PAINT[0]![0];
}

const shade = (hex: string, amount: number) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + (amount > 0 ? (255 - c) * amount : c * amount))));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
};

export interface VehicleLook {
  /** Nonzero = brake lights on. */
  braking: boolean;
  /** Headlights and beams, for dark or wet weather. */
  beams: boolean;
  /** Emergency lights on, and which half of the flash cycle we are in. */
  flashing: boolean;
  flashPhase: number;
  parked: boolean;
}

const GLASS = '#18222e';
const GLASS_HI = 'rgba(160,190,220,0.25)';

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  else ctx.rect(x, y, w, h);
}

/** Trapezoid across the car between two x positions, narrower at one end. */
function glassBand(ctx: CanvasRenderingContext2D, xBack: number, xFront: number, halfBack: number, halfFront: number) {
  ctx.beginPath();
  ctx.moveTo(xBack, -halfBack);
  ctx.lineTo(xFront, -halfFront);
  ctx.lineTo(xFront, halfFront);
  ctx.lineTo(xBack, halfBack);
  ctx.closePath();
  ctx.fillStyle = GLASS;
  ctx.fill();
}

function lamps(ctx: CanvasRenderingContext2D, L: number, W: number, look: VehicleLook) {
  const hx = L / 2 - 0.14;
  ctx.fillStyle = look.beams ? '#fff7d1' : '#d9dccf';
  ctx.fillRect(hx, -W / 2 + 0.12, 0.12, 0.38);
  ctx.fillRect(hx, W / 2 - 0.5, 0.12, 0.38);
  ctx.fillStyle = look.braking ? '#ff3030' : '#7d1d1d';
  ctx.fillRect(-L / 2 + 0.02, -W / 2 + 0.12, 0.12, 0.42);
  ctx.fillRect(-L / 2 + 0.02, W / 2 - 0.54, 0.12, 0.42);
}

function lightBar(ctx: CanvasRenderingContext2D, x: number, W: number, look: VehicleLook, colours: [string, string]) {
  const on = look.flashing;
  const a = look.flashPhase < 0.5;
  ctx.fillStyle = on ? (a ? colours[0] : '#3a1010') : shade(colours[0], -0.5);
  ctx.fillRect(x - 0.18, -W * 0.38, 0.36, W * 0.36);
  ctx.fillStyle = on ? (a ? '#10103a' : colours[1]) : shade(colours[1], -0.5);
  ctx.fillRect(x - 0.18, W * 0.02, 0.36, W * 0.36);
}

/** A car-shaped vehicle: compact, sedan, SUV, minivan, rideshare, police. */
function car(ctx: CanvasRenderingContext2D, kind: VehicleKind, L: number, W: number, paint: string, look: VehicleLook) {
  const police = kind === 'police';
  const body = police ? '#1d222a' : paint;
  rr(ctx, -L / 2, -W / 2, L, W, 0.55);
  ctx.fillStyle = body;
  ctx.fill();
  if (police) {
    // White doors, the classic black-and-white.
    ctx.fillStyle = '#e9edf2';
    ctx.fillRect(-L * 0.2, -W / 2, L * 0.36, W);
  }

  // Cabin proportions differ by body style.
  const cabin =
    kind === 'suv' ? { back: -0.4, roofFront: 0.1, glassFront: 0.24 } :
    kind === 'minivan' ? { back: -0.44, roofFront: 0.14, glassFront: 0.3 } :
    kind === 'compact' ? { back: -0.28, roofFront: 0.1, glassFront: 0.24 } :
    { back: -0.3, roofFront: 0.08, glassFront: 0.24 };
  const half = W * 0.4;
  // Rear window, roof, windshield.
  glassBand(ctx, L * (cabin.back - 0.08), L * cabin.back, half * 0.86, half);
  ctx.fillStyle = police ? '#2a3039' : shade(body, -0.12);
  ctx.fillRect(L * cabin.back, -half, L * (cabin.roofFront - cabin.back), half * 2);
  glassBand(ctx, L * cabin.roofFront, L * cabin.glassFront, half, half * 0.82);
  ctx.fillStyle = GLASS_HI;
  ctx.fillRect(L * cabin.roofFront + 0.05, -half * 0.7, 0.12, half * 1.4);

  if (kind === 'suv') {
    ctx.strokeStyle = 'rgba(20,20,20,0.55)';
    ctx.lineWidth = 0.08;
    ctx.beginPath();
    ctx.moveTo(L * cabin.back + 0.2, -half + 0.12);
    ctx.lineTo(L * cabin.roofFront - 0.15, -half + 0.12);
    ctx.moveTo(L * cabin.back + 0.2, half - 0.12);
    ctx.lineTo(L * cabin.roofFront - 0.15, half - 0.12);
    ctx.stroke();
  }
  if (kind === 'minivan') {
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    ctx.moveTo(-L * 0.1, -W / 2);
    ctx.lineTo(-L * 0.1, -W / 2 + 0.25);
    ctx.stroke();
  }
  // Mirrors.
  ctx.fillStyle = shade(body, -0.25);
  ctx.fillRect(L * cabin.glassFront - 0.15, -W / 2 - 0.14, 0.22, 0.16);
  ctx.fillRect(L * cabin.glassFront - 0.15, W / 2 - 0.02, 0.22, 0.16);

  if (police) lightBar(ctx, L * ((cabin.back + cabin.roofFront) / 2), W, look, ['#ff2a2a', '#2a6bff']);
  if (kind === 'rideshare') {
    ctx.fillStyle = look.parked ? '#8a2a6b' : '#ff4fd8';
    ctx.fillRect(L * -0.1, -0.22, 0.32, 0.44);
  }
  lamps(ctx, L, W, look);
}

function pickup(ctx: CanvasRenderingContext2D, L: number, W: number, paint: string, look: VehicleLook) {
  rr(ctx, -L / 2, -W / 2, L, W, 0.45);
  ctx.fillStyle = paint;
  ctx.fill();
  // The bed: open, darker, with rails.
  ctx.fillStyle = '#23282f';
  ctx.fillRect(-L / 2 + 0.18, -W / 2 + 0.2, L * 0.4, W - 0.4);
  ctx.strokeStyle = shade(paint, -0.3);
  ctx.lineWidth = 0.1;
  ctx.strokeRect(-L / 2 + 0.18, -W / 2 + 0.2, L * 0.4, W - 0.4);
  const half = W * 0.4;
  const cabBack = -L / 2 + 0.18 + L * 0.4 + 0.15;
  glassBand(ctx, cabBack, cabBack + 0.18, half * 0.8, half * 0.8);
  ctx.fillStyle = shade(paint, -0.12);
  ctx.fillRect(cabBack + 0.18, -half, L * 0.2, half * 2);
  glassBand(ctx, cabBack + 0.18 + L * 0.2, cabBack + 0.18 + L * 0.2 + 0.75, half, half * 0.8);
  lamps(ctx, L, W, look);
}

function bus(ctx: CanvasRenderingContext2D, L: number, W: number, index: number, look: VehicleLook) {
  const scarlet = index % 3 !== 0;
  rr(ctx, -L / 2, -W / 2, L, W, 0.6);
  ctx.fillStyle = scarlet ? '#e8e8e6' : '#c9ccd1';
  ctx.fill();
  // Window strips down both sides and a broad windshield.
  ctx.fillStyle = GLASS;
  ctx.fillRect(-L / 2 + 0.8, -W / 2 + 0.1, L - 2, 0.32);
  ctx.fillRect(-L / 2 + 0.8, W / 2 - 0.42, L - 2, 0.32);
  ctx.fillRect(L / 2 - 0.5, -W / 2 + 0.2, 0.4, W - 0.4);
  ctx.fillStyle = scarlet ? '#bb0000' : '#4b5563';
  ctx.fillRect(-L / 2 + 0.6, -0.22, L - 1.4, 0.44);
  // Roof air-conditioning units.
  ctx.fillStyle = '#9aa1aa';
  ctx.fillRect(-L * 0.15, -0.7, 1.6, 1.4);
  ctx.fillRect(L * 0.15, -0.7, 1.2, 1.4);
  ctx.fillStyle = '#6b7280';
  ctx.fillRect(-L * 0.15 + 0.2, -0.45, 1.2, 0.9);
  lamps(ctx, L, W, look);
}

function rv(ctx: CanvasRenderingContext2D, L: number, W: number, look: VehicleLook) {
  rr(ctx, -L / 2, -W / 2, L, W, 0.5);
  ctx.fillStyle = '#ece4d3';
  ctx.fill();
  ctx.fillStyle = '#8b5e34';
  ctx.fillRect(-L / 2 + 0.4, -W / 2, L - 1.2, 0.18);
  ctx.fillRect(-L / 2 + 0.4, W / 2 - 0.18, L - 1.2, 0.18);
  ctx.fillStyle = GLASS;
  ctx.fillRect(L / 2 - 0.55, -W / 2 + 0.25, 0.42, W - 0.5);
  // Roof vents and an awning rail.
  ctx.fillStyle = '#b9b2a2';
  for (const x of [-L * 0.3, -L * 0.05, L * 0.2]) ctx.fillRect(x, -0.4, 0.8, 0.8);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 0.06;
  ctx.strokeRect(-L / 2 + 0.3, -W / 2 + 0.3, L - 1.2, W - 0.6);
  lamps(ctx, L, W, look);
}

function motorcycle(ctx: CanvasRenderingContext2D, L: number, W: number, paint: string, look: VehicleLook) {
  ctx.fillStyle = '#1b1f24';
  rr(ctx, -L / 2, -W * 0.22, L, W * 0.44, 0.2);
  ctx.fill();
  ctx.fillStyle = paint;
  rr(ctx, -L * 0.15, -W * 0.3, L * 0.45, W * 0.6, 0.2);
  ctx.fill();
  // Rider's helmet and the handlebars.
  ctx.fillStyle = '#0d0f12';
  ctx.beginPath();
  ctx.arc(-L * 0.05, 0, 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#9aa1aa';
  ctx.lineWidth = 0.07;
  ctx.beginPath();
  ctx.moveTo(L * 0.3, -W / 2);
  ctx.lineTo(L * 0.3, W / 2);
  ctx.stroke();
  ctx.fillStyle = look.braking ? '#ff3030' : '#7d1d1d';
  ctx.fillRect(-L / 2, -0.08, 0.1, 0.16);
}

function ambulance(ctx: CanvasRenderingContext2D, L: number, W: number, look: VehicleLook) {
  rr(ctx, -L / 2, -W / 2, L, W, 0.4);
  ctx.fillStyle = '#f4f5f2';
  ctx.fill();
  // Box body behind the cab, with the stripe and a roof cross.
  ctx.fillStyle = '#d4252f';
  ctx.fillRect(-L / 2, -W / 2, L * 0.7, 0.22);
  ctx.fillRect(-L / 2, W / 2 - 0.22, L * 0.7, 0.22);
  ctx.fillRect(-L * 0.18 - 0.2, -0.65, 0.4, 1.3);
  ctx.fillRect(-L * 0.18 - 0.65, -0.2, 1.3, 0.4);
  ctx.fillStyle = '#d9dce0';
  ctx.fillRect(L * 0.2, -W / 2 + 0.05, 0.08, W - 0.1);
  glassBand(ctx, L * 0.3, L * 0.42, W * 0.4, W * 0.34);
  lightBar(ctx, L * 0.24, W, look, ['#ff2a2a', '#ffffff']);
  lamps(ctx, L, W, look);
}

export interface DrawOptions {
  kind: VehicleKind;
  index: number;
  look: VehicleLook;
  /** Screen pixels per meter. */
  scale: number;
}

/**
 * Draw one vehicle centred at the current transform's origin. The caller has
 * already translated to the vehicle's centre and rotated to its heading.
 */
export function drawVehicle(ctx: CanvasRenderingContext2D, { kind, index, look, scale }: DrawOptions): void {
  const type = VEHICLE_TYPES[kind];
  const L = type.lengthM;
  const W = type.widthM;
  const lengthPx = L * scale;
  const paint = paintFor(index);

  if (lengthPx < 4.5) {
    // Too small for anything but its colour, and red tail if braking.
    ctx.fillStyle = kind === 'police' ? '#5d8bff' : kind === 'ambulance' ? '#ffffff' : kind === 'bus' ? '#e8e8e6' : paint;
    ctx.fillRect(-L / 2, -W / 2, L, W);
    if (look.braking && lengthPx > 2.2) {
      ctx.fillStyle = '#ff3030';
      ctx.fillRect(-L / 2, -W / 2, Math.min(L, 1.2), W);
    }
    return;
  }

  if (lengthPx >= 9 && !look.parked) {
    // Soft shadow, for a sense of height above the asphalt.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    rr(ctx, -L / 2 + 0.25, -W / 2 + 0.3, L, W, 0.5);
    ctx.fill();
  }
  if (look.beams && lengthPx >= 8) {
    const g = ctx.createLinearGradient(L / 2, 0, L / 2 + 9, 0);
    g.addColorStop(0, 'rgba(255,240,190,0.28)');
    g.addColorStop(1, 'rgba(255,240,190,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(L / 2, -W / 2 + 0.2);
    ctx.lineTo(L / 2 + 9, -W / 2 - 1.6);
    ctx.lineTo(L / 2 + 9, W / 2 + 1.6);
    ctx.lineTo(L / 2, W / 2 - 0.2);
    ctx.closePath();
    ctx.fill();
  }
  if (look.braking && lengthPx >= 8) {
    ctx.fillStyle = 'rgba(255,40,40,0.28)';
    ctx.fillRect(-L / 2 - 0.9, -W / 2, 0.9, W);
  }
  if (look.flashing) {
    const colour = look.flashPhase < 0.5 ? 'rgba(255,40,40,0.32)' : kind === 'police' ? 'rgba(50,110,255,0.32)' : 'rgba(255,255,255,0.28)';
    const g = ctx.createRadialGradient(0, 0, 0.5, 0, 0, 9);
    g.addColorStop(0, colour);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-9, -9, 18, 18);
  }

  if (lengthPx < 14) {
    // Mid zoom: body, windshield, tails.
    const body = kind === 'police' ? '#1d222a' : kind === 'ambulance' ? '#f4f5f2' : kind === 'bus' ? '#e8e8e6' : kind === 'rv' ? '#ece4d3' : paint;
    rr(ctx, -L / 2, -W / 2, L, W, 0.5);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.fillStyle = GLASS;
    ctx.fillRect(L / 2 - Math.min(1.6, L * 0.3), -W * 0.38, Math.min(0.7, L * 0.12), W * 0.76);
    if (kind === 'pickup') {
      ctx.fillStyle = '#23282f';
      ctx.fillRect(-L / 2 + 0.2, -W / 2 + 0.25, L * 0.38, W - 0.5);
    }
    if (kind === 'police' || kind === 'ambulance') lightBar(ctx, 0, W, look, kind === 'police' ? ['#ff2a2a', '#2a6bff'] : ['#ff2a2a', '#ffffff']);
    ctx.fillStyle = look.braking ? '#ff3030' : '#7d1d1d';
    ctx.fillRect(-L / 2, -W / 2 + 0.1, 0.2, W - 0.2);
    return;
  }

  switch (kind) {
    case 'pickup':
      pickup(ctx, L, W, paint, look);
      return;
    case 'bus':
      bus(ctx, L, W, index, look);
      return;
    case 'rv':
      rv(ctx, L, W, look);
      return;
    case 'motorcycle':
      motorcycle(ctx, L, W, paint, look);
      return;
    case 'ambulance':
      ambulance(ctx, L, W, look);
      return;
    default:
      car(ctx, kind, L, W, paint, look);
  }
}

/** A small standalone picture of a vehicle kind, for the legend. */
export function vehicleIcon(kind: VehicleKind, canvas: HTMLCanvasElement, index = 3): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 60;
  const h = canvas.clientHeight || 20;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // One scale for every icon, so the legend itself shows the relative sizes.
  const scale = (canvas.width * 0.92) / VEHICLE_TYPES.bus.lengthM;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(scale, scale);
  drawVehicle(ctx, {
    kind,
    index,
    scale: scale / dpr * 4,
    look: { braking: false, beams: false, flashing: kind === 'police' || kind === 'ambulance', flashPhase: 0.2, parked: false },
  });
}
