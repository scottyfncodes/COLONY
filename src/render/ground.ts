import { MAP_H, MAP_W, Tile, tileAt, ZONES } from '../sim/world';
import { hash, poly, shade, P, line, type Ctx } from './draw';
import { HALF_H, HALF_W } from './iso';

// Static terrain, painted once into an offscreen canvas.

export const GROUND_PAD = 80;
export const GROUND_W = MAP_W * HALF_W * 2 + GROUND_PAD * 2;
export const GROUND_H = (MAP_W + MAP_H) * HALF_H + GROUND_PAD * 2;
/** World-screen origin offset inside the ground canvas. */
export const GROUND_OX = MAP_H * HALF_W + GROUND_PAD;
export const GROUND_OY = GROUND_PAD;

const BASE: Record<number, string> = {
  [Tile.Dirt]: '#6a5b47',
  [Tile.Concrete]: '#7f7b72',
  [Tile.Asphalt]: '#4d4b48',
  [Tile.Floor]: '#8b8273',
  [Tile.Soil]: '#5a4330',
  [Tile.Grass]: '#5b6739',
  [Tile.Wall]: '#8b8273',
  [Tile.Fence]: '#6e6a60',
  [Tile.Pad]: '#88857c',
  [Tile.Road]: '#47454a',
};

function diamond(x: number, y: number) {
  return [P(x, y), P(x + 1, y), P(x + 1, y + 1), P(x, y + 1)];
}

function speckle(ctx: Ctx, x: number, y: number, n: number, color: string, size: number, seed: number) {
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const u = hash(x, y, seed + i * 3);
    const v = hash(x, y, seed + i * 3 + 1);
    const p = P(x + u, y + v);
    ctx.fillRect(p.x, p.y, size, size * 0.6);
  }
}

export function paintGround(scale: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.ceil(GROUND_W * scale);
  c.height = Math.ceil(GROUND_H * scale);
  const ctx = c.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.translate(GROUND_OX, GROUND_OY);


  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const t = tileAt(x, y);
      const v = hash(x, y, 1) * 0.08 - 0.04;
      let base = BASE[t] ?? '#777';
      if (t === Tile.Wall) base = BASE[Tile.Floor];
      if (t === Tile.Fence) base = x < 2 || x > 29 || y < 2 || y > 29 ? BASE[Tile.Dirt] : '#77736a';
      poly(ctx, diamond(x, y), shade(base, v));
      switch (t) {
        case Tile.Concrete:
        case Tile.Pad: {
          // Slab joints every few tiles, stains and cracks.
          ctx.globalAlpha = 0.35;
          if (x % 3 === 0) line(ctx, P(x, y), P(x, y + 1), '#5d5a53', 1);
          if (y % 3 === 0) line(ctx, P(x, y), P(x + 1, y), '#5d5a53', 1);
          ctx.globalAlpha = 1;
          speckle(ctx, x, y, 6, 'rgba(40,36,30,0.25)', 1.6, 3);
          speckle(ctx, x, y, 4, 'rgba(255,250,235,0.12)', 1.4, 9);
          if (hash(x, y, 4) < 0.12) {
            const p = P(x + 0.5, y + 0.5);
            ctx.fillStyle = 'rgba(25,22,20,0.22)';
            ctx.beginPath();
            ctx.ellipse(p.x, p.y, 10 + hash(x, y, 5) * 12, 5 + hash(x, y, 6) * 5, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          if (hash(x, y, 7) < 0.18) {
            ctx.strokeStyle = 'rgba(30,28,24,0.45)';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            let px = x + hash(x, y, 8);
            let py = y + hash(x, y, 9);
            const s = P(px, py);
            ctx.moveTo(s.x, s.y);
            for (let i = 0; i < 4; i++) {
              px += (hash(x, y, 10 + i) - 0.5) * 0.5;
              py += (hash(x, y, 20 + i) - 0.3) * 0.4;
              const q = P(px, py);
              ctx.lineTo(q.x, q.y);
            }
            ctx.stroke();
          }
          if (t === Tile.Pad) {
            ctx.globalAlpha = 0.25;
            poly(ctx, diamond(x, y), undefined, '#4c4a44', 0.6);
            ctx.globalAlpha = 1;
          }
          break;
        }
        case Tile.Asphalt:
        case Tile.Road:
          speckle(ctx, x, y, 10, 'rgba(255,255,255,0.06)', 1.2, 11);
          speckle(ctx, x, y, 6, 'rgba(0,0,0,0.25)', 1.5, 12);
          if (t === Tile.Road && y === 15) {
            const a = P(x + 0.2, y + 1);
            const b = P(x + 0.7, y + 1);
            line(ctx, a, b, 'rgba(214,180,80,0.55)', 2);
          }
          if (t === Tile.Asphalt && y === 11 && x % 2 === 0 && x < 21) line(ctx, P(x + 0.5, y + 0.1), P(x + 0.5, y + 0.9), 'rgba(230,225,210,0.35)', 1.5);
          break;
        case Tile.Floor:
        case Tile.Wall:
          poly(ctx, diamond(x, y), undefined, 'rgba(60,52,44,0.35)', 0.6);
          speckle(ctx, x, y, 4, 'rgba(50,40,30,0.2)', 1.4, 13);
          break;
        case Tile.Soil: {
          for (let i = 0; i < 3; i++) {
            const f = 0.2 + i * 0.3;
            line(ctx, P(x, y + f), P(x + 1, y + f), 'rgba(35,24,15,0.45)', 1.2);
          }
          speckle(ctx, x, y, 5, 'rgba(160,130,90,0.25)', 1.3, 14);
          break;
        }
        case Tile.Grass:
        case Tile.Dirt: {
          speckle(ctx, x, y, 7, t === Tile.Grass ? 'rgba(120,140,70,0.6)' : 'rgba(120,105,80,0.45)', 1.6, 15);
          if (t === Tile.Grass || hash(x, y, 16) < 0.25) {
            ctx.strokeStyle = t === Tile.Grass ? 'rgba(140,160,80,0.75)' : 'rgba(130,130,70,0.55)';
            ctx.lineWidth = 1;
            for (let i = 0; i < 6; i++) {
              const p = P(x + hash(x, y, 30 + i), y + hash(x, y, 40 + i));
              ctx.beginPath();
              ctx.moveTo(p.x, p.y);
              ctx.lineTo(p.x + (hash(x, y, 50 + i) - 0.5) * 4, p.y - 3 - hash(x, y, 60 + i) * 4);
              ctx.stroke();
            }
          }
          break;
        }
      }
    }
  }
  // Hazard stripes along the generator pad edge and zone labels painted on the ground.
  for (const z of ZONES) {
    ctx.globalAlpha = 0.18;
    poly(ctx, [P(z.x0, z.y0), P(z.x1 + 1, z.y0), P(z.x1 + 1, z.y1 + 1), P(z.x0, z.y1 + 1)], undefined, '#e0c060', 2);
    ctx.globalAlpha = 1;
  }
  // Tyre tracks along the road out of the gate.
  ctx.strokeStyle = 'rgba(25,22,20,0.25)';
  ctx.lineWidth = 3;
  for (const off of [15.3, 16.6]) {
    ctx.beginPath();
    const a = P(21, off);
    const b = P(32, off);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  void HALF_W;
  return c;
}
