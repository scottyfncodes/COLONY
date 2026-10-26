import { MAP_H, MAP_W } from '../sim/world';
import { box, cylinder, hash, line, P, poly, rgba, shade, type Ctx } from './draw';
import { iso } from './iso';

// The wasteland beyond the fence: static terrain and ruins painted once, with
// atmospheric haze that thickens with distance so the compound sits in a deep world.
// Survivors never walk here, so it needs no depth sorting against dynamic sprites.
// Only low props stand in front of the compound (south/east) so nothing tall ever
// covers it; ruins and pylons rise behind it (north/west).

export const RING = 14; // tiles of outskirts on each side
export const HAZE = '#56493a';
const X0 = -RING;
const Y0 = -RING;
const X1 = MAP_W + RING;
const Y1 = MAP_H + RING;
const TOP_PAD = 260; // room for tall ruins at the back
const PAD = 40;

export interface Outskirts {
  canvas: HTMLCanvasElement;
  /** World-screen coordinates of the canvas's top-left corner. */
  wx: number;
  wy: number;
  scale: number;
  haze: string;
}

/** Distant fires that smoulder in the ruins (renderer adds smoke and night glow). */
/** Extra fires when society has collapsed: the whole district is burning. */
export const COLLAPSE_FIRES: { x: number; y: number; z: number }[] = [
  { x: 4.5, y: -10.5, z: 100 },
  { x: 25.5, y: -10, z: 120 },
  { x: -11, y: 28, z: 40 },
  { x: 35.5, y: -8, z: 70 },
];

export const FIRES: { x: number; y: number; z: number }[] = [
  { x: -8.2, y: 20.6, z: 18 },
  { x: 11.5, y: -8.5, z: 70 },
  { x: -10, y: -4, z: 40 },
];

function inMap(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;
}

const isRoadEW = (x: number, y: number) => x >= MAP_W && (y === 15 || y === 16);
const isRoadNS = (x: number) => x === 38 || x === 39;
const creekY = (x: number) => MAP_H + 6 + Math.sin(x * 0.35) * 1.6 + Math.sin(x * 0.11 + 1) * 1.2;

/** Large soft patches of tint so the land reads as terrain rather than a grid. */
function terrain(ctx: Ctx): void {
  const tints = ['rgba(95,98,52,0.32)', 'rgba(40,30,22,0.28)', 'rgba(140,118,86,0.22)', 'rgba(80,66,48,0.3)'];
  for (let i = 0; i < 140; i++) {
    let x = X0 + hash(i, 1) * (X1 - X0);
    let y = Y0 + hash(i, 2) * (Y1 - Y0);
    if (inMap(Math.floor(x), Math.floor(y))) x = x < MAP_W / 2 ? x - MAP_W / 2 : x + MAP_W / 2;
    if (inMap(Math.floor(x), Math.floor(y))) y = y < MAP_H / 2 ? y - MAP_H / 2 : y + MAP_H / 2;
    const c = P(x, y);
    const r = 40 + hash(i, 3) * 120;
    const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
    g.addColorStop(0, tints[i % tints.length]);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, r, r * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Low rises: lit on the sun side, shaded on the far side.
  for (const [x, y, r] of [[-9, 32, 4], [44, 2, 3.5], [-11, -6, 3], [28, 40, 4], [44, 40, 3], [-2, 44, 3.5]] as const) {
    const c = P(x, y);
    const rx = r * 45;
    const g = ctx.createRadialGradient(c.x - rx * 0.3, c.y - rx * 0.2, 0, c.x, c.y, rx);
    g.addColorStop(0, 'rgba(170,145,105,0.35)');
    g.addColorStop(0.6, 'rgba(120,100,72,0.12)');
    g.addColorStop(1, 'rgba(30,22,16,0.25)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, rx, rx * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A dry creek bed winding across the south, with standing puddles. */
function creek(ctx: Ctx): void {
  const pts: { x: number; y: number }[] = [];
  for (let x = X0; x <= X1; x += 0.5) pts.push(P(x, creekY(x)));
  const stroke = (color: string, w: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };
  stroke('rgba(120,100,74,0.5)', 30);
  stroke('rgba(52,42,32,0.85)', 20);
  stroke('rgba(40,32,26,0.9)', 9);
  for (let i = 0; i < 9; i++) {
    const x = X0 + 4 + i * 6.3 + hash(i, 4) * 3;
    const p = P(x, creekY(x));
    ctx.fillStyle = 'rgba(96,124,132,0.45)';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, 10 + hash(i, 5) * 12, 3 + hash(i, 6) * 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function groundTile(ctx: Ctx, x: number, y: number): void {
  const d = [P(x, y), P(x + 1, y), P(x + 1, y + 1), P(x, y + 1)];
  const v = hash(x + 99, y + 99, 3) * 0.1 - 0.05;
  let base = '#665640';
  if (isRoadEW(x, y) || (isRoadNS(x) && y >= Y0)) base = '#4a4846';
  poly(ctx, d, shade(base, v));
  if (base === '#4a4846') {
    // Cracked asphalt and faded lane markings.
    if (isRoadEW(x, y) && y === 15 && x % 2 === 0) line(ctx, P(x + 0.2, 16), P(x + 0.7, 16), 'rgba(214,180,80,0.4)', 2);
    if (isRoadNS(x) && x === 38 && y % 2 === 0) line(ctx, P(39, y + 0.2), P(39, y + 0.7), 'rgba(214,180,80,0.35)', 2);
    if (hash(x, y, 7) < 0.3) {
      ctx.strokeStyle = 'rgba(20,18,16,0.5)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      const a = P(x + hash(x, y, 8), y + hash(x, y, 9));
      ctx.moveTo(a.x, a.y);
      const b = P(x + hash(x, y, 10), y + hash(x, y, 11));
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    return;
  }
  // Speckle, stones and dry tufts.
  ctx.fillStyle = 'rgba(30,24,18,0.3)';
  for (let i = 0; i < 5; i++) {
    const p = P(x + hash(x, y, 20 + i), y + hash(x, y, 30 + i));
    ctx.fillRect(p.x, p.y, 1.6, 1);
  }
  if (hash(x, y, 40) < 0.35) {
    ctx.strokeStyle = 'rgba(150,140,80,0.55)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const p = P(x + hash(x, y, 50 + i), y + hash(x, y, 60 + i));
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + (hash(x, y, 70 + i) - 0.5) * 5, p.y - 3 - hash(x, y, 80 + i) * 4);
      ctx.stroke();
    }
  }
}

function rail(ctx: Ctx): void {
  for (let y = Y0; y < Y1; y++) {
    for (let k = 0; k < 3; k++) {
      const yy = y + k / 3;
      line(ctx, P(-6.05, yy + 0.1), P(-5.0, yy + 0.1), '#3a2a1c', 3);
    }
  }
  line(ctx, P(-5.8, Y0), P(-5.8, Y1), '#6e665e', 1.6);
  line(ctx, P(-5.25, Y0), P(-5.25, Y1), '#6e665e', 1.6);
}

// ---------------------------------------------------------------- props

type Prop = { depth: number; draw: (ctx: Ctx) => void };

function windows(ctx: Ctx, x: number, y: number, w: number, h: number, floors: number, side: 'left' | 'right', top: number, seed: number) {
  for (let f = 0; f < floors; f++) {
    const z = 10 + f * 22;
    if (z + 12 > top) break;
    const n = Math.round((side === 'left' ? w : h) * 2);
    for (let i = 0; i < n; i++) {
      if (hash(seed, f, i) < 0.15) continue;
      const u = (i + 0.3) / n;
      const pts =
        side === 'left'
          ? [P(x + u * w, y + h, z), P(x + (u + 0.5 / n) * w, y + h, z), P(x + (u + 0.5 / n) * w, y + h, z + 12), P(x + u * w, y + h, z + 12)]
          : [P(x + w, y + u * h, z), P(x + w, y + (u + 0.5 / n) * h, z), P(x + w, y + (u + 0.5 / n) * h, z + 12), P(x + w, y + u * h, z + 12)];
      poly(ctx, pts, 'rgba(18,14,12,0.85)');
    }
  }
}

/** A ruined multi-storey block with a jagged, broken top. */
function ruin(x: number, y: number, w: number, h: number, ht: number, color: string, seed: number): Prop {
  return {
    depth: x + w / 2 + y + h / 2,
    draw: (ctx) => {
      const steps = 6;
      // Build in vertical slices with varying heights for a broken skyline.
      for (let i = 0; i < steps; i++) {
        const sx = x + (w * i) / steps;
        const sh = ht * (0.55 + 0.45 * hash(seed, i));
        box(ctx, sx, y, w / steps, h, 0, sh, color);
      }
      for (let i = 0; i < steps; i++) {
        const sy = y + (h * i) / steps;
        const sh = ht * (0.5 + 0.5 * hash(seed, i, 2));
        box(ctx, x + w - 0.01, sy, 0.01, h / steps, 0, sh, color);
      }
      windows(ctx, x, y, w, h, Math.floor(ht / 22), 'left', ht * 0.55, seed);
      windows(ctx, x, y, w, h, Math.floor(ht / 22), 'right', ht * 0.5, seed + 1);
      // Rebar sticking out of the broken top
      for (let i = 0; i < 4; i++) {
        const p = P(x + hash(seed, i, 5) * w, y + h, ht * 0.55);
        line(ctx, p, { x: p.x + (hash(seed, i, 6) - 0.5) * 8, y: p.y - 10 - hash(seed, i, 7) * 10 }, '#2a2420', 1.2);
      }
      // Rubble apron
      for (let i = 0; i < 10; i++) box(ctx, x - 0.3 + hash(seed, i, 8) * (w + 0.6), y + h + hash(seed, i, 9) * 0.8, 0.3, 0.25, 0, 3 + hash(seed, i, 10) * 5, shade(color, -0.2));
    },
  };
}

function burntHouse(x: number, y: number, seed: number): Prop {
  return {
    depth: x + 1 + y + 1,
    draw: (ctx) => {
      box(ctx, x - 0.2, y - 0.2, 2.4, 2.4, 0, 3, '#5a5650');
      const wall = '#4a3c30';
      box(ctx, x, y, 2, 0.15, 0, 34, wall);
      box(ctx, x, y, 0.15, 2, 0, 30, wall);
      box(ctx, x + 1.85, y, 0.15, 1.2, 0, 26, wall);
      box(ctx, x, y + 1.85, 1.1, 0.15, 0, 20, wall);
      // Charred roof beams
      for (let i = 0; i < 4; i++) line(ctx, P(x + 0.2 + i * 0.5, y + 0.1, 34), P(x + 0.4 + i * 0.5, y + 1.6, 18 - i * 2), '#1c1612', 2.5);
      // Soot
      ctx.fillStyle = 'rgba(15,12,10,0.4)';
      const c = P(x + 1, y + 1);
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 40, 18, 0, 0, Math.PI * 2);
      ctx.fill();
      void seed;
    },
  };
}

function pylon(x: number, y: number): Prop {
  return {
    depth: x + y + 0.5,
    draw: (ctx) => {
      const b = [P(x, y), P(x + 0.6, y), P(x + 0.6, y + 0.6), P(x, y + 0.6)];
      const t = P(x + 0.3, y + 0.3, 140);
      ctx.strokeStyle = '#2d2824';
      ctx.lineWidth = 1.6;
      for (const p of b) {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(t.x, t.y);
        ctx.stroke();
      }
      for (const z of [40, 80, 115]) {
        const k = z / 140;
        const pts = b.map((p) => ({ x: p.x + (t.x - p.x) * k, y: p.y + (t.y - p.y) * k }));
        poly(ctx, pts, undefined, '#2d2824', 1);
      }
      line(ctx, P(x - 0.9, y + 0.3, 125), P(x + 1.5, y + 0.3, 125), '#2d2824', 2);
    },
  };
}

function wires(ctx: Ctx, pts: { x: number; y: number }[]): void {
  ctx.strokeStyle = 'rgba(30,26,22,0.7)';
  ctx.lineWidth = 0.8;
  for (const off of [-0.8, 1.4]) {
    ctx.beginPath();
    for (let i = 0; i < pts.length - 1; i++) {
      const a = P(pts[i].x + off, pts[i].y + 0.3, 125);
      const b = P(pts[i + 1].x + off, pts[i + 1].y + 0.3, 125);
      if (i === 0) ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo((a.x + b.x) / 2, (a.y + b.y) / 2 + 26, b.x, b.y);
    }
    ctx.stroke();
  }
}

function waterTower(x: number, y: number): Prop {
  return {
    depth: x + y + 1,
    draw: (ctx) => {
      // Toppled: tank on its side, legs splayed.
      for (const [a, b] of [[[x, y], [x + 1.2, y + 0.4]], [[x + 0.2, y + 1], [x + 1.4, y + 0.9]], [[x + 0.6, y + 0.2], [x + 0.8, y + 1.3]]] as const) {
        line(ctx, P(a[0], a[1], 0), P(b[0], b[1], 34), '#3a332c', 3);
      }
      cylinder(ctx, x + 2.2, y + 0.9, 0.9, 0, 48, '#6f6a5e', '#58544a');
      line(ctx, P(x + 1.6, y + 0.2, 52), P(x + 2.9, y + 1.6, 30), 'rgba(140,70,40,0.6)', 3);
    },
  };
}

function containers(x: number, y: number, seed: number): Prop {
  const cols = ['#7a3e2a', '#3f5a6a', '#6a6a3a', '#8a5a2a'];
  return {
    depth: x + 1 + y + 2.5,
    draw: (ctx) => {
      box(ctx, x, y, 1.3, 4, 0, 28, cols[seed % 4]);
      box(ctx, x + 1.4, y + 0.3, 1.3, 4, 0, 28, cols[(seed + 1) % 4]);
      box(ctx, x + 0.2, y + 0.6, 1.3, 4, 28, 28, cols[(seed + 2) % 4]);
      for (let k = 0; k < 10; k++) line(ctx, P(x + 2.7, y + 0.3 + k * 0.4, 1), P(x + 2.7, y + 0.3 + k * 0.4, 27), 'rgba(0,0,0,0.18)', 0.7);
    },
  };
}

function billboard(x: number, y: number): Prop {
  return {
    depth: x + y + 0.5,
    draw: (ctx) => {
      line(ctx, P(x, y + 0.2, 0), P(x, y + 0.2, 70), '#3a332c', 3);
      line(ctx, P(x, y + 1.6, 0), P(x, y + 1.6, 64), '#3a332c', 3);
      poly(ctx, [P(x, y - 0.4, 64), P(x, y + 2.2, 56), P(x, y + 2.2, 100), P(x, y - 0.4, 112)], '#8a7a5a', '#3a332c');
      poly(ctx, [P(x, y + 0.2, 72), P(x, y + 1.2, 69), P(x, y + 1.2, 96), P(x, y + 0.2, 100)], 'rgba(160,60,40,0.55)');
      poly(ctx, [P(x, y + 1.4, 66), P(x, y + 2.2, 56), P(x, y + 2.2, 78), P(x, y + 1.6, 86)], '#2a241e');
    },
  };
}

function car(x: number, y: number, ew: boolean, color: string, seed: number): Prop {
  return {
    depth: x + y + 1,
    draw: (ctx) => {
      const w = ew ? 1.9 : 0.8;
      const h = ew ? 0.8 : 1.9;
      box(ctx, x, y, w, h, 2, 11, color);
      if (ew) box(ctx, x + 0.5, y + 0.08, 0.95, 0.64, 13, 10, shade(color, -0.05));
      else box(ctx, x + 0.08, y + 0.5, 0.64, 0.95, 13, 10, shade(color, -0.05));
      ctx.fillStyle = rgba('#7a3a20', 0.6);
      for (let i = 0; i < 6; i++) {
        const p = P(x + hash(seed, i) * w, y + h, 4 + hash(seed, i, 1) * 8);
        ctx.fillRect(p.x, p.y, 3, 2);
      }
    },
  };
}

function rubble(x: number, y: number, seed: number, n = 8): Prop {
  return {
    depth: x + y + 0.5,
    draw: (ctx) => {
      for (let i = 0; i < n; i++) {
        const s = 0.15 + hash(seed, i, 3) * 0.3;
        box(ctx, x + hash(seed, i) * 1.4, y + hash(seed, i, 1) * 1.2, s, s * 0.8, 0, 3 + hash(seed, i, 2) * 6, i % 3 ? '#6a6258' : '#7a4a30');
      }
    },
  };
}

function barrier(x: number, y: number): Prop {
  return { depth: x + y + 0.5, draw: (ctx) => box(ctx, x, y, 0.9, 0.35, 0, 9, '#8a867c') };
}

function deadTree(x: number, y: number, size: number): Prop {
  return {
    depth: x + y,
    draw: (ctx) => {
      const b = P(x, y);
      const seed = Math.floor(x * 13 + y * 7) & 0xffff;
      ctx.strokeStyle = '#2e241c';
      ctx.lineCap = 'round';
      const branch = (px: number, py: number, ang: number, len: number, w: number, d: number) => {
        const nx = px + Math.cos(ang) * len;
        const ny = py + Math.sin(ang) * len;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(nx, ny);
        ctx.stroke();
        if (d > 0) {
          branch(nx, ny, ang - 0.5 - hash(seed, d) * 0.3, len * 0.7, w * 0.65, d - 1);
          branch(nx, ny, ang + 0.4 + hash(seed, d, 1) * 0.3, len * 0.65, w * 0.6, d - 1);
        }
      };
      branch(b.x, b.y, -Math.PI / 2, 18 * size, 3.5 * size, 3);
    },
  };
}

function crosses(x: number, y: number): Prop {
  return {
    depth: x + y + 1,
    draw: (ctx) => {
      for (let i = 0; i < 4; i++) {
        const px = x + (i % 2) * 0.9;
        const py = y + Math.floor(i / 2) * 0.9;
        poly(ctx, [P(px - 0.15, py, 0), P(px + 0.45, py, 0), P(px + 0.45, py + 0.55, 0), P(px - 0.15, py + 0.55, 0)], 'rgba(70,52,36,0.8)');
        line(ctx, P(px + 0.15, py + 0.25, 0), P(px + 0.15, py + 0.25, 16), '#7a6448', 2);
        line(ctx, P(px, py + 0.25, 11), P(px + 0.3, py + 0.25, 11), '#7a6448', 2);
      }
    },
  };
}

function tents(x: number, y: number): Prop {
  return {
    depth: x + y + 1,
    draw: (ctx) => {
      poly(ctx, [P(x, y + 1), P(x + 1.4, y + 1), P(x + 0.7, y + 0.5, 18)], '#5a6a4a');
      poly(ctx, [P(x + 1.4, y + 1), P(x + 1.4, y), P(x + 0.7, y + 0.5, 18)], '#465436');
      poly(ctx, [P(x + 2, y + 1.6), P(x + 3.2, y + 1.9), P(x + 2.6, y + 1.2, 8)], '#6a5a4a');
      cylinder(ctx, x + 1.8, y + 0.4, 0.2, 0, 2, '#2a2420', '#3a2a20');
    },
  };
}

function props(): Prop[] {
  const out: Prop[] = [
    // Behind the compound (north): a ruined district and a pylon line.
    ruin(-11, -12, 4, 3, 190, '#5c5852', 11),
    ruin(-4, -10, 3, 3, 120, '#66605a', 12),
    ruin(3, -12, 5, 3, 150, '#5a564e', 13),
    ruin(11, -11, 3, 3, 96, '#6a645c', 14),
    ruin(24, -12, 4, 4, 170, '#58544c', 15),
    ruin(34, -9, 3, 3, 110, '#625c54', 16),
    waterTower(17, -6),
    containers(28, -6, 2),
    pylon(6, -3),
    pylon(16, -3),
    pylon(26, -3),
    // West: burnt-out houses along the rail line.
    ruin(-13, 2, 3, 3, 80, '#605a52', 17),
    burntHouse(-9, 6, 1),
    burntHouse(-10, 13, 2),
    burntHouse(-9, 20, 3),
    ruin(-13, 26, 3, 4, 64, '#5e584e', 18),
    billboard(-3, 24),
    containers(-4, -2, 1),
    // Front: only low things.
    car(33.5, 15.2, true, '#5a6f80', 1),
    car(41, 16.1, true, '#7a5a3a', 2),
    car(38.1, 24, false, '#6a6a5a', 3),
    car(39.1, 6, false, '#4a5a4a', 4),
    barrier(37.8, 30),
    barrier(38.9, 30.3),
    barrier(38.4, 12.2),
    rubble(35, 34, 1, 12),
    rubble(22, 38, 2),
    rubble(8, 36, 3, 10),
    rubble(44, 22, 4),
    rubble(36, 3, 5),
    crosses(33.5, 25),
    tents(-5, 35),
  ];
  const trees: [number, number, number][] = [
    [-2, 8, 1], [-3, 17, 1.2], [-1.5, 30, 0.9], [34, 36, 1], [42, 30, 1.2], [44, 9, 0.9], [12, 42, 1.1], [26, 43, 0.9],
    [-8, 42, 1], [3, 40, 1.1], [40, 40, 0.9], [-12, 36, 1.2], [44, -2, 1], [20, 36, 0.8], [35, 44, 1],
  ];
  for (const [x, y, s] of trees) out.push(deadTree(x, y, s));
  return out;
}

export function paintOutskirts(scale: number, haze = HAZE): Outskirts {
  const left = iso(X0, Y1).x - PAD;
  const right = iso(X1, Y0).x + PAD;
  const top = iso(X0, Y0).y - TOP_PAD;
  const bottom = iso(X1, Y1).y + PAD;
  const c = document.createElement('canvas');
  c.width = Math.ceil((right - left) * scale);
  c.height = Math.ceil((bottom - top) * scale);
  const ctx = c.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.translate(-left, -top);
  ctx.fillStyle = haze;
  ctx.fillRect(left, top, right - left, bottom - top);
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) if (!inMap(x, y)) groundTile(ctx, x, y);
  terrain(ctx);
  creek(ctx);
  rail(ctx);
  const ps = props().sort((a, b) => a.depth - b.depth);
  // Power lines between the pylons.
  for (const p of ps) p.draw(ctx);
  wires(ctx, [{ x: 6, y: -3 }, { x: 16, y: -3 }, { x: 26, y: -3 }, { x: 36, y: -3 }]);
  // Aerial perspective: haze thickens with distance from the fence, until the edge dissolves.
  ctx.globalCompositeOperation = 'source-atop';
  const diamond = (d: number, reverse: boolean) => {
    const pts = [P(-d, -d), P(MAP_W + d, -d), P(MAP_W + d, MAP_H + d), P(-d, MAP_H + d)];
    if (reverse) pts.reverse();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const q of pts.slice(1)) ctx.lineTo(q.x, q.y);
    ctx.closePath();
  };
  for (let k = 1; k <= RING * 2; k++) {
    const d = k / 2;
    ctx.fillStyle = rgba(haze, Math.min(0.9, 0.05 + 0.8 * Math.pow(d / RING, 1.35)));
    ctx.beginPath();
    diamond(d, false);
    diamond(d - 0.5, true);
    ctx.fill();
  }
  // Beyond the ring (including ruin tops that rise past it) everything sinks into the dust.
  ctx.fillStyle = rgba(haze, 0.9);
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top);
  diamond(RING, true);
  ctx.fill('evenodd');
  ctx.globalCompositeOperation = 'source-over';
  return { canvas: c, wx: left, wy: top, scale, haze };
}
