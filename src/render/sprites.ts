import { blueprint } from '../sim/actions';
import { count, rawCapacity } from '../sim/inventory';
import type { GameState, Survivor, WorldObject } from '../sim/types';
import { box, cylinder, hash, line, P, poly, rgba, shade, shadow, strHash, groundQuad, type Ctx } from './draw';
import { iso } from './iso';

// Procedural sprites for every world object, drawn in world-screen space.

export interface DrawEnv {
  t: number; // seconds, for animation
  state: GameState;
  night: number; // 0..1
}

const RUST = '#8a4b2a';
const STEEL = '#8e9399';
const WOOD = '#8a6a44';

function rustSpots(ctx: Ctx, o: WorldObject, z: number, n: number) {
  const seed = strHash(o.id);
  ctx.fillStyle = rgba(RUST, 0.7);
  for (let i = 0; i < n; i++) {
    const p = P(o.x + 0.2 + hash(seed, i) * (o.w - 0.4), o.y + o.h - 0.02, z + hash(seed, i, 2) * 18);
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, 2 + hash(seed, i, 3) * 3, 1.5 + hash(seed, i, 4) * 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function sandbags(ctx: Ctx, o: WorldObject) {
  ctx.fillStyle = '#a08e66';
  ctx.strokeStyle = '#6e603f';
  ctx.lineWidth = 0.6;
  const ring: [number, number][] = [];
  for (let i = 0; i <= o.w * 3; i++) ring.push([o.x - 0.05 + (i / 3), o.y + o.h + 0.05]);
  for (let i = 0; i <= o.h * 3; i++) ring.push([o.x + o.w + 0.05, o.y + o.h - i / 3]);
  for (const [x, y] of ring) {
    for (let k = 0; k < 2; k++) {
      const p = P(x, y, 3 + k * 5);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 6, 3.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

function tarpRoof(ctx: Ctx, o: WorldObject, h: number) {
  const x0 = o.x - 0.1;
  const y0 = o.y - 0.1;
  const x1 = o.x + o.w + 0.1;
  const y1 = o.y + o.h + 0.1;
  for (const [x, y] of [[x0, y1], [x1, y1], [x1, y0]] as const) line(ctx, P(x, y), P(x, y, h), '#5a4a35', 2);
  poly(ctx, [P(x0, y0, h + 6), P(x1, y0, h + 6), P(x1, y1, h - 2), P(x0, y1, h - 2)], 'rgba(60,92,110,0.82)', 'rgba(30,50,60,0.9)');
  line(ctx, P(x0, (y0 + y1) / 2, h + 2), P(x1, (y0 + y1) / 2, h + 2), 'rgba(120,160,180,0.5)', 1);
}

function light(ctx: Ctx, x: number, y: number, z: number, color: string, on: boolean, r = 2.2) {
  const p = P(x, y, z);
  ctx.fillStyle = on ? color : '#2c2a28';
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
  if (on) {
    ctx.fillStyle = rgba(color, 0.25);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function blink(t: number, rate = 1.2): boolean {
  return Math.floor(t * rate * 2) % 2 === 0;
}

// ---------------------------------------------------------------- individual objects

function generator(ctx: Ctx, o: WorldObject, env: DrawEnv) {
  const running = o.state === 'operational' && !!o.data.running;
  const jitter = running ? Math.sin(env.t * 60) * 0.4 : 0;
  box(ctx, o.x, o.y, o.w, o.h, 0, 5, '#6d6a62');
  if (o.state === 'dismantled') {
    for (let i = 0; i < 5; i++) box(ctx, o.x + 0.3 + hash(i, 1) * 1.2, o.y + 0.3 + hash(i, 2) * 1.2, 0.2, 0.15, 5, 3, STEEL);
    return;
  }
  ctx.save();
  ctx.translate(jitter, 0);
  const body = o.state === 'operational' ? '#5d6b3a' : '#59603f';
  box(ctx, o.x + 0.18, o.y + 0.25, 1.64, 1.5, 5, 30, body);
  // Radiator grille on the right face
  for (let i = 0; i < 6; i++) {
    const yy = o.y + 0.4 + i * 0.2;
    line(ctx, P(o.x + 1.82, yy, 10), P(o.x + 1.82, yy, 30), shade(body, -0.6), 1);
  }
  // Panels on the left face
  poly(ctx, [P(o.x + 0.35, o.y + 1.75, 12), P(o.x + 1.0, o.y + 1.75, 12), P(o.x + 1.0, o.y + 1.75, 30), P(o.x + 0.35, o.y + 1.75, 30)], shade(body, -0.32), shade(body, -0.55));
  // Control box
  box(ctx, o.x + 1.15, o.y + 1.45, 0.45, 0.25, 35, 12, '#3e423a');
  light(ctx, o.x + 1.3, o.y + 1.7, 42, '#7cff6a', running);
  light(ctx, o.x + 1.5, o.y + 1.7, 42, '#ff4a3a', o.state !== 'operational' && blink(env.t));
  // Exhaust stack
  cylinder(ctx, o.x + 0.45, o.y + 0.45, 0.09, 35, 26, '#3a3734', '#1b1a19');
  if (o.state !== 'operational') rustSpots(ctx, o, 8, 9);
  if (o.state === 'flooded') {
    ctx.fillStyle = 'rgba(70,110,140,0.45)';
    const c = P(o.x + 1, o.y + 1.6);
    ctx.beginPath();
    ctx.ellipse(c.x, c.y + 6, 44, 14, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (o.data.efficient) {
    // The fitted forklift engine: a yellow block bolted on top.
    box(ctx, o.x + 0.4, o.y + 0.8, 0.6, 0.6, 35, 10, '#c9a227');
  }
  ctx.restore();
  if (o.reinforced) {
    sandbags(ctx, o);
    tarpRoof(ctx, o, 62);
  }
}

function forklift(ctx: Ctx, o: WorldObject, env: DrawEnv) {
  if (o.state === 'dismantled') {
    groundQuad(ctx, o.x + 0.1, o.y + 0.2, 0.8, 1.6, 'rgba(25,20,15,0.35)');
    box(ctx, o.x + 0.3, o.y + 0.4, 0.4, 0.2, 0, 3, STEEL);
    return;
  }
  if (o.data.away) {
    groundQuad(ctx, o.x + 0.1, o.y + 0.2, 0.8, 1.6, 'rgba(25,20,15,0.25)');
    return;
  }
  const y0 = o.state === 'operational' ? '#d7a425' : '#b98c2b';
  // Wheels
  for (const [dx, dy] of [[0.12, 0.3], [0.12, 1.5], [0.78, 0.3], [0.78, 1.5]]) {
    const flat = o.state === 'broken' && dy > 1;
    cylinder(ctx, o.x + dx, o.y + dy, 0.13, 0, flat ? 5 : 8, '#1e1d1c', '#3a3836');
  }
  box(ctx, o.x + 0.1, o.y + 0.25, 0.8, 1.45, 6, 14, y0);
  // Counterweight
  box(ctx, o.x + 0.12, o.y + 0.25, 0.76, 0.35, 20, 12, shade(y0, -0.3));
  // Seat and cage
  if (o.state !== 'stripped') box(ctx, o.x + 0.3, o.y + 0.75, 0.4, 0.35, 20, 6, '#2b2a28');
  else {
    poly(ctx, [P(o.x + 0.2, o.y + 0.65, 20.5), P(o.x + 0.8, o.y + 0.65, 20.5), P(o.x + 0.8, o.y + 1.25, 20.5), P(o.x + 0.2, o.y + 1.25, 20.5)], '#151413');
  }
  for (const [dx, dy] of [[0.15, 0.65], [0.85, 0.65], [0.15, 1.35], [0.85, 1.35]]) line(ctx, P(o.x + dx, o.y + dy, 20), P(o.x + dx, o.y + dy, 46), '#2b2a28', 2);
  poly(ctx, [P(o.x + 0.15, o.y + 0.65, 46), P(o.x + 0.85, o.y + 0.65, 46), P(o.x + 0.85, o.y + 1.35, 46), P(o.x + 0.15, o.y + 1.35, 46)], 'rgba(30,30,30,0.6)');
  // Mast and forks at the front (south end)
  for (const dx of [0.25, 0.75]) line(ctx, P(o.x + dx, o.y + 1.78, 6), P(o.x + dx, o.y + 1.78, 58), '#3a3a38', 3);
  for (const dx of [0.3, 0.7]) poly(ctx, [P(o.x + dx - 0.05, o.y + 1.8, 7), P(o.x + dx + 0.05, o.y + 1.8, 7), P(o.x + dx + 0.05, o.y + 2.3, 7), P(o.x + dx - 0.05, o.y + 2.3, 7)], '#4a4a48');
  if (o.state !== 'operational') rustSpots(ctx, { ...o, h: 1.7 }, 8, 6);
  light(ctx, o.x + 0.5, o.y + 1.72, 30, '#ffd27a', o.state === 'operational' && env.night > 0.3, 1.8);
}

function batteryBank(ctx: Ctx, o: WorldObject, env: DrawEnv) {
  if (o.state === 'dismantled') {
    box(ctx, o.x + 0.1, o.y + 0.1, o.w - 0.2, o.h - 0.2, 0, 4, '#4a4a48');
    return;
  }
  box(ctx, o.x + 0.08, o.y + 0.12, o.w - 0.16, o.h - 0.24, 0, 20, '#51565c');
  const cells = 6;
  for (let i = 0; i < cells; i++) {
    const dead = o.state === 'damaged' && (i === 1 || i === 4);
    box(ctx, o.x + 0.18 + i * 0.28, o.y + 0.25, 0.22, 0.5, 20, 8, dead ? '#2a2422' : '#3d6c8a');
    light(ctx, o.x + 0.29 + i * 0.28, o.y + 0.27, 30, '#ffcf4a', !dead && o.state === 'operational', 1.2);
  }
  if (o.state === 'operational') {
    const frac = env.state.power.capacity ? env.state.power.stored / env.state.power.capacity : 0;
    const a = P(o.x + 0.2, o.y + o.h - 0.12, 6);
    const b = P(o.x + 0.2 + 1.6 * frac, o.y + o.h - 0.12, 6);
    line(ctx, P(o.x + 0.2, o.y + o.h - 0.12, 6), P(o.x + 1.8, o.y + o.h - 0.12, 6), '#222', 3);
    line(ctx, a, b, frac > 0.25 ? '#7cff6a' : '#ffb03a', 3);
  } else if (blink(env.t, 0.7) && o.state === 'damaged') {
    const p = P(o.x + 0.5, o.y + 0.5, 32);
    ctx.fillStyle = '#fff6a0';
    ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
  }
  if (o.reinforced) tarpRoof(ctx, o, 40);
}

function waterPump(ctx: Ctx, o: WorldObject, env: DrawEnv) {
  cylinder(ctx, o.x + 0.5, o.y + 0.5, 0.42, 0, 10, '#7d7a72', '#2b3a40');
  if (o.state === 'dismantled') return;
  const on = o.state === 'operational' && o.powered && o.on;
  box(ctx, o.x + 0.3, o.y + 0.3, 0.4, 0.4, 10, 18, o.state === 'operational' ? '#3c6e8f' : '#4a5d66');
  cylinder(ctx, o.x + 0.5, o.y + 0.5, 0.12, 28, 6, '#2f3b40');
  // Outlet pipe toward the tank
  line(ctx, P(o.x + 0.7, o.y + 0.6, 14), P(o.x + 1.5, o.y + 0.9, 14), '#8f9499', 3);
  light(ctx, o.x + 0.5, o.y + 0.7, 24, '#7cff6a', on);
  if (on) {
    const k = (env.t * 3) % 1;
    const p = P(o.x + 1.45, o.y + 0.9, 14 - k * 10);
    ctx.fillStyle = 'rgba(150,200,230,0.8)';
    ctx.fillRect(p.x, p.y, 2, 2);
  }
  if (o.state === 'broken') rustSpots(ctx, o, 10, 4);
  if (o.state === 'flooded') {
    const c = P(o.x + 0.5, o.y + 1);
    ctx.fillStyle = 'rgba(70,110,140,0.45)';
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, 26, 10, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (o.reinforced) tarpRoof(ctx, o, 42);
}

function waterTank(ctx: Ctx, o: WorldObject, env: DrawEnv) {
  if (o.state === 'dismantled') {
    groundQuad(ctx, o.x + 0.2, o.y + 0.2, 1.6, 1.6, 'rgba(30,30,30,0.3)');
    return;
  }
  const cx = o.x + 1;
  const cy = o.y + 1;
  box(ctx, o.x + 0.1, o.y + 0.1, 1.8, 1.8, 0, 6, '#6f6b63');
  cylinder(ctx, cx, cy, 0.82, 6, 64, '#b8c2c0', '#cfd6d4');
  // Water level band (translucent tank)
  const frac = Math.min(1, count(env.state, 'rawWater') / Math.max(1, rawCapacity(env.state)));
  const c = iso(cx, cy, 6);
  const rx = 0.82 * 45;
  ctx.fillStyle = 'rgba(60,110,140,0.35)';
  ctx.fillRect(c.x - rx + 4, c.y - 60 * frac, 6, 60 * frac);
  for (let i = 1; i < 4; i++) {
    ctx.strokeStyle = 'rgba(80,90,90,0.35)';
    ctx.beginPath();
    ctx.ellipse(c.x, c.y - i * 16, rx, rx / 2, 0, 0, Math.PI);
    ctx.stroke();
  }
  if (o.state === 'damaged') {
    ctx.strokeStyle = '#3a3a38';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c.x + 10, c.y - 46);
    ctx.lineTo(c.x + 14, c.y - 36);
    ctx.lineTo(c.x + 11, c.y - 28);
    ctx.lineTo(c.x + 16, c.y - 16);
    ctx.stroke();
    const k = (env.t * 1.5) % 1;
    ctx.fillStyle = 'rgba(120,170,200,0.8)';
    ctx.fillRect(c.x + 16, c.y - 16 + k * 16, 1.5, 2.5);
    ctx.fillStyle = 'rgba(70,110,140,0.35)';
    ctx.beginPath();
    ctx.ellipse(c.x + 18, c.y + 14, 20, 7, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (o.reinforced) {
    // Ratchet straps
    for (const f of [0.3, 0.7]) {
      ctx.strokeStyle = '#c96a2a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y - 64 * f, rx + 1, rx / 2 + 1, 0, 0, Math.PI);
      ctx.stroke();
    }
    sandbags(ctx, o);
  }
}

function pipes(ctx: Ctx, o: WorldObject) {
  if (o.state === 'dismantled') return;
  if (o.state === 'laid') {
    // Manifold with a run toward the growing plot
    box(ctx, o.x + 0.2, o.y + 0.3, 1.6, 0.4, 0, 6, '#6b6f73');
    cylinder(ctx, o.x + 0.5, o.y + 0.5, 0.12, 6, 10, '#9aa0a5');
    cylinder(ctx, o.x + 1.5, o.y + 0.5, 0.12, 6, 10, '#9aa0a5');
    ctx.setLineDash([]);
    const pts = [P(o.x + 0.5, o.y + 0.6, 3), P(19.5, 21.6, 3), P(13.5, 21.6, 3)];
    ctx.strokeStyle = '#8f9499';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    line(ctx, P(25.5, 18.9, 3), P(o.x + 1.6, o.y + 0.5, 3), '#8f9499', 2.5);
    return;
  }
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < 3 - r; i++) {
      const yy = o.y + 0.25 + i * 0.25 + r * 0.12;
      const z = 3 + r * 7;
      box(ctx, o.x + 0.1, yy, 1.8, 0.2, z, 6, i % 2 ? '#9aa0a5' : '#848a8f');
    }
  }
  rustSpots(ctx, o, 6, 3);
}

function scrapPile(ctx: Ctx, o: WorldObject) {
  if (o.state === 'dismantled') return;
  const seed = strHash(o.id);
  const n = 7 + o.w * 4;
  const cols = [RUST, '#6d6a62', '#4a4642', '#7f6a4a', '#2a2826', '#5d6b3a'];
  shadow(ctx, o.x + o.w / 2, o.y + 0.5, 18 * o.w, 9, 0.25);
  for (let i = 0; i < n; i++) {
    const u = 0.15 + hash(seed, i) * (o.w - 0.3);
    const v = 0.15 + hash(seed, i, 1) * 0.7;
    const z = hash(seed, i, 2) * 8 * (1 - Math.abs(v - 0.5));
    const s = 0.12 + hash(seed, i, 3) * 0.22;
    const col = cols[Math.floor(hash(seed, i, 4) * cols.length)];
    if (hash(seed, i, 5) < 0.2) cylinder(ctx, o.x + u, o.y + v, s, z, 5, '#1c1b1a', '#333');
    else box(ctx, o.x + u - s / 2, o.y + v - s / 2, s, s * 0.7, z, 3 + hash(seed, i, 6) * 7, col);
  }
  // A plank or two sticking out
  const a = P(o.x + 0.2, o.y + 0.7, 2);
  const b = P(o.x + o.w - 0.1, o.y + 0.3, 16);
  line(ctx, a, b, WOOD, 3);
}

function wreckedCar(ctx: Ctx, o: WorldObject) {
  if (o.state === 'dismantled') {
    groundQuad(ctx, o.x + 0.1, o.y + 0.1, 1.8, 0.8, 'rgba(25,20,18,0.35)');
    return;
  }
  const c = '#5a6f80';
  for (const [dx, dy] of [[0.35, 0.15], [0.35, 0.85], [1.6, 0.15], [1.6, 0.85]]) cylinder(ctx, o.x + dx, o.y + dy, 0.13, 0, 6, '#1c1b1a', '#2a2826');
  box(ctx, o.x + 0.05, o.y + 0.12, 1.9, 0.76, 6, 12, c);
  box(ctx, o.x + 0.55, o.y + 0.18, 0.95, 0.64, 18, 12, shade(c, 0.05));
  // Windows
  poly(ctx, [P(o.x + 0.6, o.y + 0.82, 20), P(o.x + 1.45, o.y + 0.82, 20), P(o.x + 1.45, o.y + 0.82, 28), P(o.x + 0.6, o.y + 0.82, 28)], 'rgba(30,40,50,0.85)');
  poly(ctx, [P(o.x + 1.5, o.y + 0.22, 20), P(o.x + 1.5, o.y + 0.78, 20), P(o.x + 1.5, o.y + 0.78, 28), P(o.x + 1.5, o.y + 0.22, 28)], 'rgba(40,52,60,0.85)');
  rustSpots(ctx, { ...o, h: 0.9 }, 8, 10);
  if (o.state === 'siphoned') {
    const p = P(o.x + 0.3, o.y + 0.88, 14);
    ctx.fillStyle = '#111';
    ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    line(ctx, P(o.x + 0.3, o.y + 0.9, 14), P(o.x + 0.2, o.y + 1.2, 0), '#2a5a2a', 1.2);
  }
}

function workbench(ctx: Ctx, o: WorldObject, env: DrawEnv) {
  if (o.state === 'dismantled') {
    box(ctx, o.x + 0.2, o.y + 0.3, 1.2, 0.2, 0, 2, WOOD);
    return;
  }
  const tilt = o.state === 'damaged' ? 3 : 0;
  // Pegboard behind
  poly(ctx, [P(o.x, o.y + 0.05, 14), P(o.x + 2, o.y + 0.05, 14), P(o.x + 2, o.y + 0.05, 44), P(o.x, o.y + 0.05, 44)], '#7a6448', '#4d3e2b');
  for (let i = 0; i < 5; i++) {
    const p = P(o.x + 0.3 + i * 0.35, o.y + 0.05, 34 - (i % 2) * 6);
    line(ctx, p, { x: p.x, y: p.y + 8 }, '#444', 2);
  }
  for (const [dx, dy] of [[0.1, 0.2], [1.85, 0.2], [0.1, 0.85], [1.85, 0.85]]) line(ctx, P(o.x + dx, o.y + dy, 0), P(o.x + dx, o.y + dy, 15 - (dx > 1 && dy > 0.5 ? tilt : 0)), '#4d3e2b', 2.5);
  box(ctx, o.x + 0.05, o.y + 0.15, 1.9, 0.75, 15, 3, WOOD);
  // Vice and grinder
  box(ctx, o.x + 0.2, o.y + 0.5, 0.25, 0.2, 18, 6, '#3a5a8a');
  cylinder(ctx, o.x + 1.5, o.y + 0.5, 0.12, 18, 6, '#555');
  if (o.state === 'operational') {
    light(ctx, o.x + 1, o.y + 0.1, 46, '#ffe7b0', o.powered, 2);
    box(ctx, o.x + 0.8, o.y + 0.45, 0.3, 0.2, 18, 2, '#9aa0a5');
  } else {
    box(ctx, o.x + 0.9, o.y + 0.6, 0.4, 0.15, 18, 2, RUST);
  }
  void env;
}

function radio(ctx: Ctx, o: WorldObject, env: DrawEnv) {
  if (o.state === 'dismantled') return;
  box(ctx, o.x + 0.1, o.y + 0.15, 0.8, 0.7, 0, 14, WOOD);
  box(ctx, o.x + 0.2, o.y + 0.25, 0.6, 0.45, 14, 10, '#3a3a36');
  const on = o.state === 'operational' && o.powered;
  light(ctx, o.x + 0.5, o.y + 0.7, 20, '#9effa0', on, 1.6);
  light(ctx, o.x + 0.35, o.y + 0.7, 20, '#ffbd5a', on && blink(env.t, 3), 1.2);
  line(ctx, P(o.x + 0.7, o.y + 0.3, 24), P(o.x + 0.9, o.y + 0.1, 60), '#777', 1);
}

function gate(ctx: Ctx, o: WorldObject, env: DrawEnv) {
  const x = o.x + 0.5;
  for (const yy of [o.y, o.y + o.h]) line(ctx, P(x, yy, 0), P(x, yy, 42), '#4a4a48', 4);
  const open = o.state !== 'operational';
  ctx.strokeStyle = 'rgba(170,175,175,0.55)';
  ctx.lineWidth = 0.8;
  // Two leaves; a broken gate sags open.
  const leaves: [number, number, number][] = open ? [[o.y, 0.9, -0.7], [o.y + o.h, -0.9, -0.5]] : [[o.y, 1, 0], [o.y + o.h, -1, 0]];
  for (const [y0, dir, swing] of leaves) {
    const tipX = x + swing;
    const tipY = y0 + dir * (open ? 0.6 : 1);
    const a0 = P(x, y0, 4);
    const a1 = P(x, y0, 38);
    const b0 = P(tipX, tipY, open ? 0 : 4);
    const b1 = P(tipX, tipY, open ? 30 : 38);
    poly(ctx, [a0, b0, b1, a1], 'rgba(120,125,125,0.15)', 'rgba(70,72,72,0.9)', 1.5);
    for (let i = 1; i < 6; i++) {
      const f = i / 6;
      line(ctx, { x: a0.x + (b0.x - a0.x) * f, y: a0.y + (b0.y - a0.y) * f }, { x: a1.x + (b1.x - a1.x) * f, y: a1.y + (b1.y - a1.y) * f }, 'rgba(160,165,165,0.45)', 0.7);
    }
  }
  if (!open) {
    const p = P(x, o.y + 1, 20);
    ctx.strokeStyle = '#c9c9c9';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (o.reinforced) {
    for (const yy of [o.y - 0.2, o.y + o.h + 0.2]) box(ctx, o.x + 0.2, yy - 0.15, 0.6, 0.3, 0, 10, '#7a7a74');
  }
  void env;
}

function planter(ctx: Ctx, o: WorldObject, env: DrawEnv) {
  if (o.state === 'dismantled') return;
  const moist = (o.data.moisture ?? 0) / 100;
  box(ctx, o.x + 0.05, o.y + 0.08, o.w - 0.1, o.h - 0.16, 0, 9, { top: '#6b4f33', left: '#7a5a3a', right: '#5b4329' });
  groundQuad(ctx, o.x + 0.15, o.y + 0.18, o.w - 0.3, o.h - 0.36, shade('#5a4330', -0.25 * moist), undefined, 9);
  const seed = strHash(o.id);
  const g = (o.data.growth ?? 0) / 100;
  const plants = 8;
  for (let i = 0; i < plants; i++) {
    const u = o.x + 0.3 + (i % 4) * ((o.w - 0.6) / 3);
    const v = o.y + 0.3 + Math.floor(i / 4) * 0.4;
    const p = P(u, v, 9);
    if (o.state === 'overgrown') {
      ctx.strokeStyle = i % 2 ? '#8a8a3a' : '#6c7a34';
      ctx.lineWidth = 1;
      for (let k = 0; k < 4; k++) {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + (hash(seed, i, k) - 0.5) * 12, p.y - 6 - hash(seed, i, k + 9) * 10);
        ctx.stroke();
      }
    } else if (o.state === 'growing' || o.state === 'ready') {
      const h = 3 + g * 12;
      const sway = Math.sin(env.t * 1.5 + i) * (env.state.weather.wind * 1.5);
      ctx.strokeStyle = moist > 0 ? '#5f8f3a' : '#8a8a4a';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + sway, p.y - h);
      ctx.stroke();
      ctx.fillStyle = moist > 0 ? '#76a845' : '#9a9a50';
      ctx.beginPath();
      ctx.ellipse(p.x + sway, p.y - h, 2 + g * 4, 1.5 + g * 2.5, 0, 0, Math.PI * 2);
      ctx.fill();
      if (o.state === 'ready') {
        ctx.fillStyle = i % 2 ? '#d94a3a' : '#e8c040';
        ctx.beginPath();
        ctx.arc(p.x + sway + 2, p.y - h + 1, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (o.state === 'damaged') {
      ctx.strokeStyle = '#6a5530';
      line(ctx, p, { x: p.x + 6, y: p.y - 1 }, '#6a5530', 1.2);
    }
  }
  if (o.reinforced) {
    // Hoop cover
    ctx.strokeStyle = 'rgba(220,230,235,0.6)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= o.w * 2; i++) {
      const a = P(o.x + i * 0.5, o.y + 0.1, 9);
      const b = P(o.x + i * 0.5, o.y + o.h - 0.1, 9);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo((a.x + b.x) / 2, (a.y + b.y) / 2 - 26, b.x, b.y);
      ctx.stroke();
    }
    poly(ctx, [P(o.x, o.y + 0.1, 30), P(o.x + o.w, o.y + 0.1, 30), P(o.x + o.w, o.y + o.h - 0.1, 30), P(o.x, o.y + o.h - 0.1, 30)], 'rgba(220,235,240,0.14)');
  }
}

function cot(ctx: Ctx, o: WorldObject) {
  if (o.state === 'dismantled') return;
  for (const [dx, dy] of [[0.2, 0.1], [0.8, 0.1], [0.2, 0.9], [0.8, 0.9]]) line(ctx, P(o.x + dx, o.y + dy, 0), P(o.x + dx, o.y + dy, 7), '#3e3d3a', 1.5);
  box(ctx, o.x + 0.18, o.y + 0.08, 0.64, 0.84, 7, 2, '#5f6a44');
  box(ctx, o.x + 0.22, o.y + 0.12, 0.56, 0.2, 9, 3, '#c9c0a8');
}

function storageRack(ctx: Ctx, o: WorldObject) {
  if (o.state === 'dismantled') return;
  for (const dx of [0.1, o.w - 0.1]) for (const dy of [0.15, 0.85]) line(ctx, P(o.x + dx, o.y + dy, 0), P(o.x + dx, o.y + dy, 44), '#3d5a7a', 2);
  for (let s = 0; s < 3; s++) {
    box(ctx, o.x + 0.08, o.y + 0.12, o.w - 0.16, 0.76, 4 + s * 14, 2, '#3d5a7a');
    for (let i = 0; i < 3; i++) {
      if (hash(strHash(o.id), s, i) < 0.35) continue;
      box(ctx, o.x + 0.2 + i * 0.55, o.y + 0.25, 0.4, 0.45, 6 + s * 14, 8, i % 2 ? '#a58a5a' : '#8a7048');
    }
  }
}

function rainCatcher(ctx: Ctx, o: WorldObject, env: DrawEnv) {
  if (o.state === 'dismantled') return;
  cylinder(ctx, o.x + 0.5, o.y + 0.5, 0.25, 0, 18, '#2f5f8a');
  for (const [dx, dy] of [[0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95]]) line(ctx, P(o.x + dx, o.y + dy, 0), P(o.x + dx, o.y + dy, 34), '#5a4a35', 1.5);
  const sag = env.state.weather.rain > 0 ? 4 : 0;
  poly(ctx, [P(o.x + 0.05, o.y + 0.05, 34), P(o.x + 0.95, o.y + 0.05, 34), P(o.x + 0.5, o.y + 0.5, 22 - sag)], '#3d7a8a');
  poly(ctx, [P(o.x + 0.95, o.y + 0.05, 34), P(o.x + 0.95, o.y + 0.95, 34), P(o.x + 0.5, o.y + 0.5, 22 - sag)], '#2f6575');
  poly(ctx, [P(o.x + 0.05, o.y + 0.95, 34), P(o.x + 0.95, o.y + 0.95, 34), P(o.x + 0.5, o.y + 0.5, 22 - sag)], '#367080');
  if (o.reinforced) for (const [dx, dy] of [[0, 0], [1, 1]]) line(ctx, P(o.x + dx, o.y + dy, 34), P(o.x + dx - 0.3, o.y + dy + 0.3, 0), '#999', 0.8);
}

function sandFilter(ctx: Ctx, o: WorldObject, env: DrawEnv) {
  if (o.state === 'dismantled') return;
  box(ctx, o.x + 0.1, o.y + 0.1, 0.8, 0.8, 0, 4, '#6f6b63');
  cylinder(ctx, o.x + 0.35, o.y + 0.4, 0.2, 4, 26, '#2f5f8a');
  cylinder(ctx, o.x + 0.65, o.y + 0.65, 0.2, 4, 18, '#2f5f8a');
  line(ctx, P(o.x + 0.35, o.y + 0.4, 30), P(o.x + 0.65, o.y + 0.65, 24), '#999', 2);
  if (o.data.cartridge) cylinder(ctx, o.x + 0.75, o.y + 0.3, 0.08, 4, 16, '#e8e8e0');
  const active = count(env.state, 'rawWater') > 0.05 && o.on;
  if (active) {
    const k = (env.t * 2) % 1;
    const p = P(o.x + 0.8, o.y + 0.8, 8 - k * 6);
    ctx.fillStyle = 'rgba(170,220,240,0.9)';
    ctx.fillRect(p.x, p.y, 1.5, 2);
  }
}

function purifier(ctx: Ctx, o: WorldObject, env: DrawEnv) {
  if (o.state === 'dismantled') return;
  box(ctx, o.x + 0.1, o.y + 0.1, 0.8, 0.8, 0, 6, '#5a5a56');
  cylinder(ctx, o.x + 0.45, o.y + 0.45, 0.28, 6, 30, '#a8acaf');
  ctx.strokeStyle = '#b87333';
  ctx.lineWidth = 1.5;
  const c = P(o.x + 0.8, o.y + 0.7, 10);
  ctx.beginPath();
  for (let i = 0; i < 4; i++) ctx.ellipse(c.x, c.y - i * 5, 5, 2, 0, 0, Math.PI * 2);
  ctx.stroke();
  light(ctx, o.x + 0.45, o.y + 0.8, 20, '#ff9a3a', o.powered, 1.8);
  void env;
}

function windTurbine(ctx: Ctx, o: WorldObject, env: DrawEnv) {
  if (o.state === 'dismantled') return;
  box(ctx, o.x + 0.3, o.y + 0.3, 0.4, 0.4, 0, 4, '#6f6b63');
  const top = P(o.x + 0.5, o.y + 0.5, 92);
  line(ctx, P(o.x + 0.5, o.y + 0.5, 4), top, '#6a6e72', 3);
  for (const [dx, dy] of [[0.1, 0.1], [0.9, 0.9], [0.1, 0.9]]) line(ctx, P(o.x + dx, o.y + dy, 0), P(o.x + 0.5, o.y + 0.5, 40), '#555', 0.8);
  box(ctx, o.x + 0.42, o.y + 0.42, 0.16, 0.16, 88, 6, '#8a8f93');
  if (o.state === 'broken') {
    line(ctx, top, { x: top.x + 10, y: top.y + 12 }, '#9a9a90', 2);
    return;
  }
  const speed = o.on ? env.state.weather.wind * 9 : 0;
  const ang = env.t * speed;
  for (let i = 0; i < 3; i++) {
    const a = ang + (i * Math.PI * 2) / 3;
    const tip = { x: top.x + Math.cos(a) * 28, y: top.y + Math.sin(a) * 16 };
    ctx.strokeStyle = '#c8c4b8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
  }
  if (o.reinforced) for (const [dx, dy] of [[-0.4, 0.5], [1.4, 0.5]]) line(ctx, P(o.x + dx, o.y + dy, 0), P(o.x + 0.5, o.y + 0.5, 70), '#999', 0.8);
}

function lamp(ctx: Ctx, o: WorldObject, env: DrawEnv) {
  if (o.state === 'dismantled') return;
  box(ctx, o.x + 0.38, o.y + 0.38, 0.24, 0.24, 0, 4, '#555');
  const top = P(o.x + 0.5, o.y + 0.5, 70);
  line(ctx, P(o.x + 0.5, o.y + 0.5, 4), top, '#3d3d3b', 2.5);
  const on = o.state === 'operational' && o.powered && env.night > 0.15;
  ctx.fillStyle = o.state === 'broken' ? '#4a4038' : '#2c2c2a';
  ctx.beginPath();
  ctx.moveTo(top.x - 6, top.y);
  ctx.lineTo(top.x + 6, top.y);
  ctx.lineTo(top.x + 4, top.y + 5);
  ctx.lineTo(top.x - 4, top.y + 5);
  ctx.fill();
  if (on) {
    ctx.fillStyle = '#fff3c4';
    ctx.fillRect(top.x - 4, top.y + 4, 8, 2);
  }
}

function crate(ctx: Ctx, o: WorldObject) {
  if (o.state === 'dismantled') return;
  box(ctx, o.x + 0.15, o.y + 0.15, 0.7, 0.7, 0, 16, { top: '#b08a55', left: '#9a7646', right: '#7d5f38', edge: '#5a4228' });
  line(ctx, P(o.x + 0.15, o.y + 0.85, 0), P(o.x + 0.85, o.y + 0.85, 16), '#5a4228', 1);
}

function shelf(ctx: Ctx, o: WorldObject) {
  if (o.state === 'dismantled') return;
  for (const dx of [0.15, 0.85]) for (const dy of [0.25, 0.75]) line(ctx, P(o.x + dx, o.y + dy, 0), P(o.x + dx, o.y + dy, 40), '#5d6166', 1.5);
  for (let s = 0; s < 3; s++) box(ctx, o.x + 0.12, o.y + 0.22, 0.76, 0.56, 4 + s * 13, 1.5, '#6d7176');
  box(ctx, o.x + 0.25, o.y + 0.3, 0.3, 0.3, 5.5, 6, '#8a7048');
}

function drums(ctx: Ctx, o: WorldObject) {
  if (o.state === 'dismantled') {
    cylinder(ctx, o.x + 0.5, o.y + 0.5, 0.2, 0, 2, '#2f5f8a');
    return;
  }
  cylinder(ctx, o.x + 0.35, o.y + 0.35, 0.2, 0, 22, '#2f5f8a');
  cylinder(ctx, o.x + 0.68, o.y + 0.62, 0.2, 0, 22, '#2a568a');
}

function table(ctx: Ctx, o: WorldObject) {
  for (const [dx, dy] of [[0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) line(ctx, P(o.x + dx, o.y + dy, 0), P(o.x + dx, o.y + dy, 12), '#4d3e2b', 2);
  box(ctx, o.x + 0.08, o.y + 0.08, 0.84, 0.84, 12, 2, WOOD);
  cylinder(ctx, o.x + 0.4, o.y + 0.45, 0.06, 14, 4, '#b8b8b0');
}

function depot(ctx: Ctx, o: WorldObject, env: DrawEnv) {
  const inv = env.state.inventory;
  box(ctx, o.x + 0.05, o.y + 0.05, 1.9, 1.9, 0, 3, '#7a5f3a');
  // Pallet of crates whose height tracks stock.
  const solids = (inv.scrap ?? 0) + (inv.mech ?? 0) + (inv.elec ?? 0) + (inv.battery ?? 0);
  const layers = Math.min(3, Math.ceil(solids / 10));
  for (let l = 0; l < layers; l++) box(ctx, o.x + 0.15, o.y + 0.15, 0.8, 0.8, 3 + l * 12, 11, l % 2 ? '#8a7048' : '#a58a5a');
  // Water jugs
  const jugs = Math.min(6, Math.ceil((inv.water ?? 0) / 14));
  for (let i = 0; i < jugs; i++) cylinder(ctx, o.x + 1.2 + (i % 3) * 0.24, o.y + 0.3 + Math.floor(i / 3) * 0.3, 0.1, 3, 12, '#4f86b0', '#7fb0d0');
  // Food tins and sacks
  const food = Math.min(8, Math.ceil((inv.food ?? 0) / 3));
  for (let i = 0; i < food; i++) cylinder(ctx, o.x + 0.3 + (i % 4) * 0.2, o.y + 1.3 + Math.floor(i / 4) * 0.25, 0.07, 3, 6, i % 2 ? '#c9a24a' : '#b84a3a');
  // Fuel cans
  const fuel = Math.min(4, Math.ceil((inv.fuel ?? 0) / 5));
  for (let i = 0; i < fuel; i++) box(ctx, o.x + 1.2 + i * 0.18, o.y + 1.35, 0.14, 0.3, 3, 10, '#a83a2a');
  if ((inv.meds ?? 0) > 0) {
    box(ctx, o.x + 1.25, o.y + 1.0, 0.3, 0.2, 3, 7, '#e8e4dc');
    const p = P(o.x + 1.4, o.y + 1.2, 7);
    ctx.fillStyle = '#c33';
    ctx.fillRect(p.x - 2, p.y - 1, 4, 1.4);
    ctx.fillRect(p.x - 0.7, p.y - 2.5, 1.4, 4);
  }
}

function site(ctx: Ctx, o: WorldObject, env: DrawEnv, progress: number) {
  const bp = blueprint(o.label as WorldObject['type']);
  groundQuad(ctx, o.x, o.y, o.w, o.h, 'rgba(232,163,61,0.12)', 'rgba(232,163,61,0.7)');
  ctx.save();
  ctx.globalAlpha = 0.25 + 0.6 * progress;
  if (bp) drawObjectBody(ctx, { ...o, type: bp.type, state: bp.initialState, label: undefined }, env);
  ctx.restore();
  // Scaffold posts
  for (const [dx, dy] of [[0, 0], [o.w, 0], [0, o.h], [o.w, o.h]]) line(ctx, P(o.x + dx, o.y + dy, 0), P(o.x + dx, o.y + dy, 30), '#c9a06a', 1.5);
  line(ctx, P(o.x, o.y + o.h, 30), P(o.x + o.w, o.y + o.h, 30), '#c9a06a', 1.5);
  line(ctx, P(o.x + o.w, o.y, 30), P(o.x + o.w, o.y + o.h, 30), '#c9a06a', 1.5);
}

function drawObjectBody(ctx: Ctx, o: WorldObject, env: DrawEnv): void {
  switch (o.type) {
    case 'generator': return generator(ctx, o, env);
    case 'forklift': return forklift(ctx, o, env);
    case 'batteryBank': return batteryBank(ctx, o, env);
    case 'waterPump': return waterPump(ctx, o, env);
    case 'waterTank': return waterTank(ctx, o, env);
    case 'pipes': return pipes(ctx, o);
    case 'scrapPile': return scrapPile(ctx, o);
    case 'wreckedCar': return wreckedCar(ctx, o);
    case 'workbench': return workbench(ctx, o, env);
    case 'radio': return radio(ctx, o, env);
    case 'gate': return gate(ctx, o, env);
    case 'planter': return planter(ctx, o, env);
    case 'cot': return cot(ctx, o);
    case 'storageRack': return storageRack(ctx, o);
    case 'rainCatcher': return rainCatcher(ctx, o, env);
    case 'sandFilter': return sandFilter(ctx, o, env);
    case 'purifier': return purifier(ctx, o, env);
    case 'windTurbine': return windTurbine(ctx, o, env);
    case 'lamp': return lamp(ctx, o, env);
    case 'crate': return crate(ctx, o);
    case 'shelf': return shelf(ctx, o);
    case 'drums': return drums(ctx, o);
    case 'table': return table(ctx, o);
    case 'depot': return depot(ctx, o, env);
  }
}

export function drawObject(ctx: Ctx, o: WorldObject, env: DrawEnv, siteProgress = 0): void {
  if (o.state === 'site') return site(ctx, o, env, siteProgress);
  if (o.type !== 'gate' && o.state !== 'dismantled') shadow(ctx, o.x + o.w / 2 + 0.15, o.y + o.h / 2 + 0.1, 20 * Math.max(o.w, o.h), 10 * Math.min(o.w, o.h) + 3, 0.18, 6);
  drawObjectBody(ctx, o, env);
}

// ---------------------------------------------------------------- survivors

export interface SurvivorPose {
  x: number;
  y: number;
}

const ROLE_COLOR: Record<string, string> = {
  Mechanic: '#d98a3a',
  Electrician: '#e8c547',
  Medic: '#e85a5a',
  Builder: '#8fbf5a',
  Scavenger: '#b48ae0',
  Generalist: '#9ab0c0',
};

export function roleColor(role: string): string {
  return ROLE_COLOR[role] ?? '#ccc';
}

export function drawSurvivor(ctx: Ctx, s: Survivor, pos: SurvivorPose, env: DrawEnv, selected: boolean, cargo: boolean): void {
  const p = iso(pos.x, pos.y);
  const t = env.t + strHash(s.id) * 0.001;
  const walking = s.activity === 'walking' || s.activity === 'hauling' || s.activity === 'fetching';
  const sleeping = s.activity === 'sleeping';
  const working = s.activity === 'working';
  ctx.save();
  ctx.translate(p.x, p.y);
  if (selected) {
    ctx.strokeStyle = '#f2b544';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, 13, 6.5, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(242,181,68,0.35)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(0, 0, 16, 8, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(10,8,6,0.32)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 8, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  if (sleeping) {
    // Lying down on a cot or the floor.
    ctx.translate(0, -9);
    ctx.fillStyle = s.look.shirt;
    ctx.beginPath();
    ctx.ellipse(2, 0, 9, 4, -0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = s.look.skin;
    ctx.beginPath();
    ctx.arc(-8, 4, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d8d4c8';
    ctx.globalAlpha = 0.85;
    ctx.font = 'bold 8px sans-serif';
    const k = (t * 0.6) % 1;
    ctx.fillText('z', 4 + k * 6, -8 - k * 10);
    ctx.globalAlpha = 1;
    ctx.restore();
    return;
  }
  const bob = walking ? Math.abs(Math.sin(t * 9)) * 1.6 : 0;
  const stride = walking ? Math.sin(t * 9) * 3 : 0;
  const hunched = s.activity === 'sheltering' || s.health < 35;
  const f = s.facing;
  // Legs
  ctx.strokeStyle = '#2d2b29';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-2, -9 - bob);
  ctx.lineTo(-2 + stride, -1);
  ctx.moveTo(2, -9 - bob);
  ctx.lineTo(2 - stride, -1);
  ctx.stroke();
  // Torso
  const torsoTop = -21 - bob + (hunched ? 3 : 0);
  ctx.fillStyle = s.look.shirt;
  ctx.beginPath();
  ctx.moveTo(-5, -8 - bob);
  ctx.lineTo(5, -8 - bob);
  ctx.lineTo(5.5, torsoTop + 3);
  ctx.quadraticCurveTo(0, torsoTop - 1, -5.5, torsoTop + 3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(f > 0 ? 1 : -5, -18 - bob, 4, 10);
  // Role stripe
  ctx.fillStyle = roleColor(s.role);
  ctx.fillRect(-5, -11 - bob, 10, 1.6);
  // Arms
  ctx.strokeStyle = shade(s.look.shirt, -0.15);
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  const swing = working ? Math.sin(t * 12) * 5 : walking ? -stride : 0;
  ctx.moveTo(-5 * f, torsoTop + 4);
  ctx.lineTo(-6 * f - swing * 0.3, -11 - bob);
  ctx.moveTo(5 * f, torsoTop + 4);
  if (working) ctx.lineTo(10 * f, torsoTop + 2 + swing);
  else if (cargo) ctx.lineTo(4 * f, torsoTop - 2);
  else ctx.lineTo(6 * f + swing * 0.3, -11 - bob);
  ctx.stroke();
  if (working) {
    // Tool in hand
    ctx.strokeStyle = '#9aa0a5';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(10 * f, torsoTop + 2 + swing);
    ctx.lineTo(14 * f, torsoTop - 2 + swing);
    ctx.stroke();
  }
  // Head
  const hy = torsoTop - 5;
  ctx.fillStyle = s.look.skin;
  ctx.beginPath();
  ctx.arc(0, hy, 4.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = s.look.hair;
  ctx.beginPath();
  switch (s.look.hairStyle) {
    case 0:
      ctx.arc(0, hy - 1.2, 4.8, Math.PI * 1.05, Math.PI * 1.95);
      break;
    case 1:
      ctx.arc(0, hy - 0.8, 5, Math.PI * 0.9, Math.PI * 2.1);
      ctx.lineTo(4 * -f, hy + 5);
      break;
    case 2:
      ctx.arc(0, hy - 0.5, 5.2, Math.PI * 0.8, Math.PI * 2.2);
      ctx.lineTo(5, hy + 6);
      ctx.lineTo(-5, hy + 6);
      break;
    default:
      ctx.ellipse(0, hy - 3.2, 4.6, 2.4, 0, Math.PI, Math.PI * 2);
  }
  ctx.fill();
  if (cargo) {
    ctx.fillStyle = '#a58a5a';
    ctx.strokeStyle = '#5a4228';
    ctx.lineWidth = 0.8;
    ctx.fillRect(-4, torsoTop - 12, 8, 6);
    ctx.strokeRect(-4, torsoTop - 12, 8, 6);
  }
  // Need alert pip
  const critical = s.thirst < 15 || s.hunger < 15 || s.health < 30 || s.sick > 0 || s.injury > 40;
  if (critical) {
    ctx.fillStyle = '#e8503a';
    ctx.beginPath();
    ctx.arc(7, hy - 7, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(6.4, hy - 9, 1.2, 2.6);
    ctx.fillRect(6.4, hy - 5.6, 1.2, 1);
  }
  ctx.restore();
}

/** A stranger (Kessler visitor) standing outside the gate. */
export function drawVisitor(ctx: Ctx, x: number, y: number, shirt: string, scale: number, t: number): void {
  const p = iso(x, y);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.scale(scale, scale);
  ctx.fillStyle = 'rgba(10,8,6,0.3)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 8, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#2d2b29';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-2, -9);
  ctx.lineTo(-2, -1);
  ctx.moveTo(2, -9);
  ctx.lineTo(2, -1);
  ctx.stroke();
  ctx.fillStyle = shirt;
  ctx.fillRect(-5.5, -21, 11, 13);
  ctx.fillStyle = '#c9a07a';
  ctx.beginPath();
  ctx.arc(0, -25 + Math.sin(t * 2) * 0.4, 4.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
