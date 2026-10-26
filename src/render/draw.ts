import { iso, type Vec } from './iso';

// Drawing primitives for procedural isometric art.

export type Ctx = CanvasRenderingContext2D;

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function shade(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex);
  const t = f < 0 ? 0 : 255;
  const p = Math.abs(f);
  return `rgb(${Math.round((t - r) * p + r)},${Math.round((t - g) * p + g)},${Math.round((t - b) * p + b)})`;
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export function poly(ctx: Ctx, pts: Vec[], fill?: string, stroke?: string, lw = 1): void {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
}

export function line(ctx: Ctx, a: Vec, b: Vec, color: string, lw = 1): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.stroke();
}

/** Tile-space point with height → world-screen. */
export const P = (x: number, y: number, z = 0): Vec => iso(x, y, z);

export interface BoxColors {
  top: string;
  left?: string;
  right?: string;
  edge?: string;
}

/**
 * Axis-aligned isometric box. (x, y) is the footprint origin in tiles, (w, h) its size,
 * z the base height and ht the box height in pixels.
 */
export function box(ctx: Ctx, x: number, y: number, w: number, h: number, z: number, ht: number, c: BoxColors | string): void {
  const col: BoxColors = typeof c === 'string' ? { top: shade(c, 0.12), left: shade(c, -0.18), right: shade(c, -0.38) } : c;
  const zt = z + ht;
  // Left (south-west) face along y+h
  poly(ctx, [P(x, y + h, z), P(x + w, y + h, z), P(x + w, y + h, zt), P(x, y + h, zt)], col.left ?? shade(col.top, -0.25));
  // Right (south-east) face along x+w
  poly(ctx, [P(x + w, y, z), P(x + w, y + h, z), P(x + w, y + h, zt), P(x + w, y, zt)], col.right ?? shade(col.top, -0.45));
  // Top
  poly(ctx, [P(x, y, zt), P(x + w, y, zt), P(x + w, y + h, zt), P(x, y + h, zt)], col.top, col.edge, 0.75);
}

/** Vertical cylinder centred at tile point (cx, cy), radius r in tiles. */
export function cylinder(ctx: Ctx, cx: number, cy: number, r: number, z: number, ht: number, color: string, topColor?: string): void {
  const c = iso(cx, cy, z);
  const rx = r * 45;
  const ry = r * 22.6;
  const g = ctx.createLinearGradient(c.x - rx, 0, c.x + rx, 0);
  g.addColorStop(0, shade(color, -0.05));
  g.addColorStop(0.45, shade(color, 0.12));
  g.addColorStop(1, shade(color, -0.45));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI);
  ctx.lineTo(c.x - rx, c.y - ht);
  ctx.ellipse(c.x, c.y - ht, rx, ry, 0, Math.PI, 0, true);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = topColor ?? shade(color, 0.2);
  ctx.beginPath();
  ctx.ellipse(c.x, c.y - ht, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** Flat diamond on the ground for one or more tiles. */
export function groundQuad(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string, stroke?: string, z = 0): void {
  poly(ctx, [P(x, y, z), P(x + w, y, z), P(x + w, y + h, z), P(x, y + h, z)], fill, stroke);
}

/** Soft elliptical contact shadow. */
export function shadow(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, a = 0.28, dx = 0): void {
  const c = iso(cx, cy);
  ctx.fillStyle = `rgba(10,8,6,${a})`;
  ctx.beginPath();
  ctx.ellipse(c.x + dx, c.y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** Deterministic pseudo-random from integers, for stable decorative detail. */
export function hash(a: number, b = 0, c = 0): number {
  let h = Math.imul(a ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(c + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

export function strHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
