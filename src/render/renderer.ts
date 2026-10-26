import { OBJECT_DEFS, blueprint } from '../sim/actions';
import { consumerDemand } from '../sim/infrastructure';
import { darkness } from '../sim/time';
import { BUILDINGS, GATE_OUTSIDE, MAP_H, MAP_W, Tile, tileAt } from '../sim/world';
import type { GameState, ObjectType, Survivor, WorldObject } from '../sim/types';
import { box, hash, line, P, poly, rgba, roundRect, shade, type Ctx } from './draw';
import { Camera, iso, type Vec } from './iso';
import { GROUND_OX, GROUND_OY, paintGround } from './ground';
import { FIRES, HAZE, paintOutskirts, type Outskirts } from './outskirts';
import { drawObject, drawSurvivor, drawVisitor, type DrawEnv } from './sprites';

export type Pick =
  | { kind: 'survivor'; id: string }
  | { kind: 'object'; id: string }
  | { kind: 'tile'; x: number; y: number };

export interface ViewState {
  selectedSurvivor: string | null;
  selectedObject: string | null;
  ghost: { type: ObjectType; x: number; y: number; valid: boolean } | null;
  hover: { x: number; y: number } | null;
}

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  color: string;
  kind: 'smoke' | 'spark' | 'dust' | 'drip' | 'steam';
}

interface Floater {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
}

interface Drawable {
  depth: number;
  draw: () => void;
}

const WALL_COLORS: Record<string, string> = { warehouse: '#5f6e6c', workshop: '#7b4a3a', bunkhouse: '#8a8478' };

export class Renderer {
  readonly camera = new Camera();
  private ctx: Ctx;
  private ground: HTMLCanvasElement | null = null;
  private outskirts: Outskirts | null = null;
  private groundScale = 1;
  private dpr = 1;
  private light: HTMLCanvasElement;
  private lctx: Ctx;
  private particles: Particle[] = [];
  private floaters: Floater[] = [];
  private prevStates = new Map<string, string>();
  private prevInv: Record<string, number> = {};
  private lastT = 0;
  private flash = 0;
  /** Previous-step survivor positions, for smooth interpolation between sim ticks. */
  prevPos = new Map<string, Vec>();

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.light = document.createElement('canvas');
    this.lctx = this.light.getContext('2d')!;
  }

  resize(w: number, h: number): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.light.width = Math.round(w * this.dpr * 0.5);
    this.light.height = Math.round(h * this.dpr * 0.5);
    this.camera.width = w;
    this.camera.height = h;
    const scale = Math.min(2, this.dpr);
    if (!this.ground || scale !== this.groundScale) {
      this.groundScale = scale;
      this.ground = paintGround(scale);
    }
    if (!this.outskirts) this.outskirts = paintOutskirts(1);
  }

  snapshot(state: GameState): void {
    for (const s of state.survivors) this.prevPos.set(s.id, { x: s.x, y: s.y });
  }

  private pos(s: Survivor, alpha: number): Vec {
    const p = this.prevPos.get(s.id);
    if (!p || Math.hypot(p.x - s.x, p.y - s.y) > 2) return { x: s.x, y: s.y };
    return { x: p.x + (s.x - p.x) * alpha, y: p.y + (s.y - p.y) * alpha };
  }

  // ---------------------------------------------------------------- picking

  pick(state: GameState, sx: number, sy: number): Pick {
    const cam = this.camera;
    const w = cam.toWorld(sx, sy);
    // Survivors first (small targets get a generous radius for touch).
    let best: { id: string; d: number } | null = null;
    for (const s of state.survivors) {
      if (!s.alive || s.away) continue;
      const p = iso(s.x, s.y);
      const d = Math.hypot(w.x - p.x, (w.y - (p.y - 14)) * 0.8);
      const r = 18 / Math.min(1, cam.zoom) ** 0.5;
      if (d < r && (!best || d < best.d)) best = { id: s.id, d };
    }
    if (best) return { kind: 'survivor', id: best.id };
    // Objects: test projected bounding area, front-most first.
    const cands = state.objects
      .filter((o) => o.state !== 'dismantled' && !o.data.away)
      .map((o) => ({ o, depth: o.x + o.w / 2 + o.y + o.h / 2 }))
      .sort((a, b) => b.depth - a.depth);
    for (const { o } of cands) {
      const height = objectHeight(o);
      const left = iso(o.x, o.y + o.h).x;
      const right = iso(o.x + o.w, o.y).x;
      const top = iso(o.x, o.y).y - height;
      const bottom = iso(o.x + o.w, o.y + o.h).y;
      if (w.x < left || w.x > right || w.y < top || w.y > bottom) continue;
      // Within the box: accept if over the footprint diamond or the raised body.
      const t = cam.tileAt(sx, sy);
      const onFoot = t.x >= o.x - 0.15 && t.x <= o.x + o.w + 0.15 && t.y >= o.y - 0.15 && t.y <= o.y + o.h + 0.15;
      const midTop = iso(o.x + o.w / 2, o.y + o.h / 2).y - height;
      if (onFoot || w.y < midTop + height) return { kind: 'object', id: o.id };
    }
    const t = cam.tileAt(sx, sy);
    return { kind: 'tile', x: Math.floor(t.x), y: Math.floor(t.y) };
  }

  // ---------------------------------------------------------------- main render

  render(state: GameState, view: ViewState, alpha: number, now: number): void {
    const t = now / 1000;
    const dt = Math.min(0.1, this.lastT ? t - this.lastT : 0.016);
    this.lastT = t;
    const ctx = this.ctx;
    const cam = this.camera;
    const dark = darkness(state.minute + alpha);
    const storm = state.weather.kind === 'storm';
    const night = Math.min(1, dark + (storm ? 0.35 : state.weather.kind === 'rain' ? 0.12 : 0));
    const env: DrawEnv = { t, state, night };

    this.detectChanges(state);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = HAZE;
    ctx.fillRect(0, 0, cam.width, cam.height);

    const shakeX = storm ? Math.sin(t * 23) * 0.6 : 0;
    ctx.setTransform(this.dpr * cam.zoom, 0, 0, this.dpr * cam.zoom, this.dpr * ((-cam.x + shakeX) * cam.zoom + cam.width / 2), this.dpr * (-cam.y * cam.zoom + cam.height / 2));

    const out = this.outskirts;
    if (out) ctx.drawImage(out.canvas, out.wx, out.wy, out.canvas.width / out.scale, out.canvas.height / out.scale);
    if (this.ground) ctx.drawImage(this.ground, -GROUND_OX, -GROUND_OY, this.ground.width / this.groundScale, this.ground.height / this.groundScale);

    // Wet ground sheen during rain.
    if (state.weather.rain > 0) {
      ctx.fillStyle = `rgba(40,60,80,${0.12 * state.weather.rain})`;
      poly(ctx, [P(0, 0), P(MAP_W, 0), P(MAP_W, MAP_H), P(0, MAP_H)], ctx.fillStyle);
    }

    this.drawFloorDecals(ctx, state, view);

    const items: Drawable[] = [];
    this.collectWalls(items);
    this.collectFence(items, state);
    this.collectScenery(items);
    const jobProgress = new Map<string, number>();
    for (const j of state.jobs) jobProgress.set(j.targetId, Math.min(1, j.progress / Math.max(1, j.required)));
    for (const o of state.objects) {
      if (o.state === 'dismantled' && o.type !== 'generator' && o.type !== 'forklift' && o.type !== 'batteryBank' && o.type !== 'waterTank' && o.type !== 'wreckedCar' && o.type !== 'drums') continue;
      const depth = o.x + o.w / 2 + o.y + o.h / 2;
      items.push({ depth, draw: () => drawObject(ctx, o, env, jobProgress.get(o.id) ?? 0) });
    }
    for (const s of state.survivors) {
      if (!s.alive || s.away) continue;
      const p = this.pos(s, alpha);
      const job = s.jobId ? state.jobs.find((j) => j.id === s.jobId) : undefined;
      const cargo = !!job && (job.phase === 'haul' || (job.phase === 'travel' && Object.keys(job.staged).some((k) => k !== 'tools')));
      items.push({ depth: p.x + p.y + 0.05, draw: () => drawSurvivor(ctx, s, p, env, view.selectedSurvivor === s.id, cargo) });
    }
    if (typeof state.flags.visitors === 'number' && state.minute < state.flags.visitors) {
      const shirts = ['#6a5a8a', '#8a3a3a', '#4a5a6a'];
      shirts.forEach((c, i) => items.push({ depth: GATE_OUTSIDE.x + GATE_OUTSIDE.y + i, draw: () => drawVisitor(ctx, GATE_OUTSIDE.x - 0.4 + i * 0.5, GATE_OUTSIDE.y + 0.3 + i * 0.45, c, i === 1 ? 0.8 : 1, t + i) }));
    }
    if (view.ghost) {
      const g = view.ghost;
      const bp = blueprint(g.type);
      if (bp) {
        items.push({
          depth: g.x + bp.w / 2 + g.y + bp.h / 2 + 0.01,
          draw: () => {
            ctx.save();
            ctx.globalAlpha = 0.55;
            drawObject(ctx, { id: 'ghost', type: g.type, x: g.x, y: g.y, w: bp.w, h: bp.h, state: bp.initialState, condition: 100, reinforced: false, on: false, powered: false, data: {}, contents: {}, issues: [] }, env);
            ctx.restore();
          },
        });
      }
    }
    items.sort((a, b) => a.depth - b.depth);
    for (const it of items) it.draw();

    this.updateParticles(state, env, dt, alpha);
    this.drawParticles(ctx);

    // Screen-space passes.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawWeather(ctx, state, t, dt);
    this.drawLighting(ctx, state, night, dark, t);
    this.drawOverlays(ctx, state, view, t);
    this.drawFloaters(ctx, dt);
    if (this.flash > 0) {
      ctx.fillStyle = `rgba(230,235,255,${this.flash})`;
      ctx.fillRect(0, 0, cam.width, cam.height);
      this.flash = Math.max(0, this.flash - dt * 2.5);
    }
  }

  // ---------------------------------------------------------------- world layers

  private drawFloorDecals(ctx: Ctx, state: GameState, view: ViewState): void {
    // Selection footprint and placement ghost footprint.
    const sel = view.selectedObject ? state.objects.find((o) => o.id === view.selectedObject) : null;
    if (sel) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 250);
      poly(ctx, [P(sel.x - 0.08, sel.y - 0.08), P(sel.x + sel.w + 0.08, sel.y - 0.08), P(sel.x + sel.w + 0.08, sel.y + sel.h + 0.08), P(sel.x - 0.08, sel.y + sel.h + 0.08)], `rgba(242,181,68,${0.12 + 0.1 * pulse})`, '#f2b544', 2);
    }
    if (view.ghost) {
      const bp = blueprint(view.ghost.type);
      if (bp) {
        const g = view.ghost;
        poly(ctx, [P(g.x, g.y), P(g.x + bp.w, g.y), P(g.x + bp.w, g.y + bp.h), P(g.x, g.y + bp.h)], g.valid ? 'rgba(120,220,120,0.25)' : 'rgba(230,80,60,0.3)', g.valid ? '#8fe08f' : '#e8503a', 2);
      }
    } else if (view.hover) {
      const h = view.hover;
      poly(ctx, [P(h.x, h.y), P(h.x + 1, h.y), P(h.x + 1, h.y + 1), P(h.x, h.y + 1)], 'rgba(255,255,255,0.06)', 'rgba(255,255,255,0.25)', 1);
    }
    // Selected survivor's path and move target.
    const s = view.selectedSurvivor ? state.survivors.find((x) => x.id === view.selectedSurvivor) : null;
    if (s && s.alive && !s.away && s.path.length) {
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = 'rgba(242,181,68,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const a = iso(s.x, s.y);
      ctx.moveTo(a.x, a.y);
      for (const p of s.path) {
        const q = iso(p.x, p.y);
        ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      const end = s.path[s.path.length - 1];
      const e = iso(end.x, end.y);
      ctx.strokeStyle = '#f2b544';
      ctx.beginPath();
      ctx.ellipse(e.x, e.y, 7, 3.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private collectWalls(items: Drawable[]): void {
    const ctx = this.ctx;
    for (const b of BUILDINGS) {
      const color = WALL_COLORS[b.id] ?? '#777';
      for (let y = b.y0; y <= b.y1; y++) {
        for (let x = b.x0; x <= b.x1; x++) {
          if (tileAt(x, y) !== Tile.Wall) continue;
          const front = y === b.y1 || x === b.x1;
          const ht = front ? 12 : 46;
          items.push({
            depth: x + y + 1 - (front ? 0 : 0.6),
            draw: () => {
              box(ctx, x, y, 1, 1, 0, ht, { top: shade(color, 0.18), left: shade(color, -0.1), right: shade(color, -0.32) });
              if (!front) {
                // Corrugation / brick lines and the odd window on inner faces.
                ctx.globalAlpha = 0.25;
                for (let k = 1; k < 4; k++) {
                  if (y === b.y0) line(ctx, P(x + k / 4, y + 1, 0), P(x + k / 4, y + 1, ht), '#222', 0.6);
                  if (x === b.x0) line(ctx, P(x + 1, y + k / 4, 0), P(x + 1, y + k / 4, ht), '#222', 0.6);
                }
                ctx.globalAlpha = 1;
                if (y === b.y0 && x % 3 === 1 && x !== b.x0) poly(ctx, [P(x + 0.2, y + 1, 22), P(x + 0.8, y + 1, 22), P(x + 0.8, y + 1, 36), P(x + 0.2, y + 1, 36)], 'rgba(150,180,190,0.35)', 'rgba(40,40,40,0.6)');
                if (x === b.x0 && y % 3 === 1 && y !== b.y0) poly(ctx, [P(x + 1, y + 0.2, 22), P(x + 1, y + 0.8, 22), P(x + 1, y + 0.8, 36), P(x + 1, y + 0.2, 36)], 'rgba(150,180,190,0.3)', 'rgba(40,40,40,0.6)');
              }
            },
          });
        }
      }
    }
  }

  private collectFence(items: Drawable[], state: GameState): void {
    const ctx = this.ctx;
    const segs: { x0: number; y0: number; x1: number; y1: number; front: boolean }[] = [];
    for (let i = 2; i < 30; i++) {
      segs.push({ x0: i, y0: 2.5, x1: i + 1, y1: 2.5, front: false });
      segs.push({ x0: 2.5, y0: i, x1: 2.5, y1: i + 1, front: false });
      segs.push({ x0: i, y0: 29.5, x1: i + 1, y1: 29.5, front: true });
      if (i !== 15 && i !== 16) segs.push({ x0: 29.5, y0: i, x1: 29.5, y1: i + 1, front: true });
    }
    for (const s of segs) {
      items.push({
        depth: (s.x0 + s.x1) / 2 + (s.y0 + s.y1) / 2 + (s.front ? 0.3 : -0.3),
        draw: () => {
          const h = 34;
          const a0 = P(s.x0, s.y0, 0);
          const b0 = P(s.x1, s.y1, 0);
          const a1 = P(s.x0, s.y0, h);
          const b1 = P(s.x1, s.y1, h);
          ctx.globalAlpha = s.front ? 0.45 : 0.75;
          poly(ctx, [a0, b0, b1, a1], 'rgba(150,155,150,0.08)');
          ctx.strokeStyle = 'rgba(165,170,165,0.55)';
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          for (let k = 0; k <= 4; k++) {
            const f = k / 4;
            ctx.moveTo(a0.x + (b0.x - a0.x) * f, a0.y + (b0.y - a0.y) * f);
            ctx.lineTo(a1.x + (b1.x - a1.x) * (1 - f), a1.y + (b1.y - a1.y) * (1 - f));
            ctx.moveTo(a1.x + (b1.x - a1.x) * f, a1.y + (b1.y - a1.y) * f);
            ctx.lineTo(a0.x + (b0.x - a0.x) * (1 - f), a0.y + (b0.y - a0.y) * (1 - f));
          }
          ctx.stroke();
          line(ctx, a1, b1, 'rgba(90,90,85,0.9)', 1.2);
          line(ctx, P(s.x0, s.y0, h + 4), P(s.x1, s.y1, h + 4), 'rgba(120,120,110,0.7)', 0.6);
          ctx.globalAlpha = 1;
          line(ctx, a0, P(s.x0, s.y0, h + 6), '#4a4a46', 2.4);
        },
      });
    }
    void state;
  }

  private collectScenery(items: Drawable[]): void {
    const ctx = this.ctx;
    // Dead trees and a shipping container outside the wire.
    const trees: [number, number][] = [[0.5, 4], [1, 9], [0.4, 21], [1.2, 27], [6, 0.6], [14, 1], [22, 0.4], [30.8, 6], [31, 24], [12, 31], [24, 30.8], [4, 31], [30.6, 29]];
    for (const [x, y] of trees) {
      items.push({
        depth: x + y,
        draw: () => {
          const b = P(x, y, 0);
          const seed = Math.floor(x * 13 + y * 7);
          ctx.fillStyle = 'rgba(10,8,6,0.25)';
          ctx.beginPath();
          ctx.ellipse(b.x + 8, b.y, 14, 5, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#3a2e24';
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
          branch(b.x, b.y, -Math.PI / 2, 22 + hash(seed) * 10, 4, 3);
        },
      });
    }
    items.push({
      depth: 5 + 0.5,
      draw: () => {
        box(ctx, 4, -0.2, 4, 1.4, 0, 30, { top: '#8a4a32', left: '#7a3e2a', right: '#5e2f20' });
        for (let k = 0; k < 12; k++) line(ctx, P(4 + k / 3, 1.2, 1), P(4 + k / 3, 1.2, 29), 'rgba(0,0,0,0.2)', 0.7);
      },
    });
  }

  // ---------------------------------------------------------------- particles & feedback

  private detectChanges(state: GameState): void {
    for (const o of state.objects) {
      const prev = this.prevStates.get(o.id);
      const cur = `${o.state}|${o.reinforced}`;
      if (prev !== undefined && prev !== cur) {
        const [st] = cur.split('|');
        const c = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
        if (st === 'operational' || st === 'growing' || st === 'laid') this.floater(c.x, c.y, prev.startsWith('site') ? 'Built!' : st === 'growing' ? 'Planted' : 'Working!', '#9be37a');
        else if (st === 'dismantled') this.floater(c.x, c.y, 'Dismantled', '#e8c57a');
        else if (st === 'flooded' || st === 'broken' || st === 'damaged') this.floater(c.x, c.y, st === 'flooded' ? 'Flooded!' : 'Damaged!', '#ff7a5a');
        else if (st === 'ready') this.floater(c.x, c.y, 'Ready to harvest', '#9be37a');
        else if (cur.endsWith('true') && !prev.endsWith('true')) this.floater(c.x, c.y, 'Reinforced', '#9fd0ff');
        for (let i = 0; i < 14; i++) this.particles.push({ x: c.x, y: c.y, z: 10, vx: (Math.random() - 0.5) * 1.2, vy: (Math.random() - 0.5) * 1.2, vz: 20 + Math.random() * 30, life: 0, max: 0.8, size: 3, color: '#cbbfa8', kind: 'dust' });
      }
      this.prevStates.set(o.id, cur);
    }
    // Floating +N at the depot when stock arrives.
    const depot = state.objects.find((o) => o.id === 'depot');
    const keys = ['scrap', 'mech', 'elec', 'fuel', 'battery', 'tools', 'food', 'meds', 'engine', 'filter'];
    const gains: string[] = [];
    for (const k of keys) {
      const v = (state.inventory as Record<string, number>)[k] ?? 0;
      const p = this.prevInv[k];
      if (p !== undefined && v - p >= 0.99) gains.push(`+${Math.round(v - p)} ${k === 'mech' ? 'mech' : k === 'elec' ? 'elec' : k}`);
      this.prevInv[k] = v;
    }
    if (depot && gains.length) this.floater(depot.x + 1, depot.y + 1, gains.join('  '), '#f2d48a');
  }

  private floater(x: number, y: number, text: string, color: string): void {
    this.floaters.push({ x, y, text, color, life: 0 });
  }

  private updateParticles(state: GameState, env: DrawEnv, dt: number, alpha: number): void {
    // Smoke columns from fires still smouldering in the ruins.
    for (const f of FIRES) {
      if (Math.random() < dt * 5) {
        this.particles.push({ x: f.x + (Math.random() - 0.5) * 0.4, y: f.y, z: f.z, vx: 0.25 + state.weather.wind * 0.9, vy: -0.25 - state.weather.wind * 0.5, vz: 16 + Math.random() * 8, life: 0, max: 7, size: 7, color: '#3e3630', kind: 'smoke' });
      }
    }
    const gen = state.objects.find((o) => o.type === 'generator');
    if (gen && gen.state === 'operational' && gen.data.running && Math.random() < dt * 12) {
      this.particles.push({ x: gen.x + 0.45, y: gen.y + 0.45, z: 62, vx: 0.15 + state.weather.wind * 0.4, vy: -0.1, vz: 14, life: 0, max: 2.4, size: 4, color: '#5a5650', kind: 'smoke' });
    }
    if (gen && gen.state !== 'operational' && gen.state !== 'dismantled' && Math.random() < dt * 0.8) {
      this.particles.push({ x: gen.x + 1.2, y: gen.y + 1.5, z: 30, vx: 0.05, vy: 0, vz: 6, life: 0, max: 2, size: 3, color: '#6a645c', kind: 'smoke' });
    }
    for (const o of state.objects) {
      if (o.type === 'purifier' && o.state === 'operational' && o.powered && consumerDemand(state, o) > 0 && Math.random() < dt * 6) {
        this.particles.push({ x: o.x + 0.45, y: o.y + 0.45, z: 40, vx: 0.05, vy: -0.05, vz: 12, life: 0, max: 1.6, size: 3, color: '#e8eef0', kind: 'steam' });
      }
    }
    for (const j of state.jobs) {
      if (j.actionId !== 'boil' || j.phase !== 'work' || Math.random() > dt * 6) continue;
      const o = state.objects.find((x) => x.id === j.targetId);
      if (o) this.particles.push({ x: o.x + 0.65, y: o.y + 0.6, z: 26, vx: 0.05, vy: -0.05, vz: 12, life: 0, max: 1.6, size: 3, color: '#e8eef0', kind: 'steam' });
    }
    for (const s of state.survivors) {
      if (s.activity !== 'working' || !s.alive || s.away) continue;
      const job = state.jobs.find((j) => j.id === s.jobId);
      if (!job) continue;
      const p = this.pos(s, alpha);
      const sparky = job.skill === 'mechanical' || job.skill === 'electrical' || job.kind === 'craft';
      if (sparky && Math.random() < dt * 10) {
        this.particles.push({ x: p.x + s.facing * 0.35, y: p.y - s.facing * 0.1, z: 18, vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2, vz: 30 + Math.random() * 40, life: 0, max: 0.4, size: 1.6, color: job.skill === 'electrical' ? '#bfe8ff' : '#ffd36a', kind: 'spark' });
      } else if (!sparky && Math.random() < dt * 4) {
        this.particles.push({ x: p.x + s.facing * 0.3, y: p.y, z: 4, vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.5) * 0.6, vz: 10, life: 0, max: 0.9, size: 2.4, color: '#a89878', kind: 'dust' });
      }
    }
    const g = 90;
    for (const p of this.particles) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.kind === 'spark' || p.kind === 'dust') p.vz -= g * dt;
      if (p.z < 0) {
        p.z = 0;
        p.vz *= -0.3;
        p.vx *= 0.5;
        p.vy *= 0.5;
      }
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
    if (this.particles.length > 800) this.particles.splice(0, this.particles.length - 800);
    void env;
  }

  private drawParticles(ctx: Ctx): void {
    for (const p of this.particles) {
      const s = iso(p.x, p.y, p.z);
      const k = p.life / p.max;
      if (p.kind === 'smoke' || p.kind === 'steam') {
        ctx.fillStyle = rgba(p.color.startsWith('#') ? p.color : '#888888', (1 - k) * (p.kind === 'steam' ? 0.45 : 0.5));
        ctx.beginPath();
        ctx.arc(s.x, s.y, p.size + k * (p.max > 5 ? 34 : 10), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = rgba(p.color, 1 - k);
        ctx.fillRect(s.x - p.size / 2, s.y - p.size / 2, p.size, p.size);
      }
    }
  }

  private drawFloaters(ctx: Ctx, dt: number): void {
    ctx.font = '600 12px "Barlow Condensed", system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const f of this.floaters) {
      f.life += dt;
      const w = iso(f.x, f.y, 50 + f.life * 30);
      const s = this.camera.toScreen(w.x, w.y);
      const a = Math.max(0, 1 - f.life / 2.2);
      ctx.fillStyle = `rgba(0,0,0,${a * 0.6})`;
      ctx.fillText(f.text, s.x + 1, s.y + 1);
      ctx.fillStyle = rgba(f.color, a);
      ctx.fillText(f.text, s.x, s.y);
    }
    ctx.textAlign = 'left';
    this.floaters = this.floaters.filter((f) => f.life < 2.2);
  }

  // ---------------------------------------------------------------- weather & light

  private rain: { x: number; y: number; s: number }[] = [];

  private drawWeather(ctx: Ctx, state: GameState, t: number, dt: number): void {
    const cam = this.camera;
    const r = state.weather.rain;
    const storm = state.weather.kind === 'storm';
    if (state.weather.kind === 'overcast' || r > 0) {
      ctx.fillStyle = `rgba(60,70,80,${storm ? 0.28 : r > 0 ? 0.16 : 0.1})`;
      ctx.fillRect(0, 0, cam.width, cam.height);
    }
    if (r <= 0) {
      this.rain.length = 0;
      return;
    }
    const target = Math.floor((cam.width * cam.height) / (storm ? 2600 : 7000));
    while (this.rain.length < target) this.rain.push({ x: Math.random() * cam.width, y: Math.random() * cam.height, s: 0.6 + Math.random() * 0.6 });
    this.rain.length = Math.min(this.rain.length, target);
    const wind = storm ? 0.55 : 0.18;
    ctx.strokeStyle = storm ? 'rgba(190,205,220,0.42)' : 'rgba(190,205,220,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const d of this.rain) {
      const sp = 900 * d.s * dt;
      d.y += sp;
      d.x += sp * wind;
      if (d.y > cam.height) {
        d.y -= cam.height + 20;
        d.x = Math.random() * cam.width;
      }
      if (d.x > cam.width) d.x -= cam.width;
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - 10 * wind * d.s, d.y - 14 * d.s);
    }
    ctx.stroke();
    if (storm && Math.random() < dt * 0.25) this.flash = 0.55;
    void t;
  }

  private drawLighting(ctx: Ctx, state: GameState, night: number, dark: number, t: number): void {
    const cam = this.camera;
    // Warm dusk / cold night grading.
    const mod = (state.minute % 1440) / 60;
    if (dark > 0 && dark < 1) {
      const dusk = mod > 12;
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = dusk ? `rgba(255,170,110,${0.35 * (1 - Math.abs(dark - 0.4))})` : `rgba(255,190,150,${0.25 * (1 - dark)})`;
      ctx.fillRect(0, 0, cam.width, cam.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (night <= 0.02) return;
    const L = this.lctx;
    const lw = this.light.width;
    const lh = this.light.height;
    const k = lw / cam.width;
    L.globalCompositeOperation = 'source-over';
    L.clearRect(0, 0, lw, lh);
    L.fillStyle = `rgba(8,12,28,${0.74 * night})`;
    L.fillRect(0, 0, lw, lh);
    L.globalCompositeOperation = 'destination-out';
    const lights: { x: number; y: number; z: number; r: number; a: number; warm: string }[] = [];
    const powered = state.power.supply > 0 || state.power.stored > 0.1;
    for (const o of state.objects) {
      if (o.type === 'lamp' && o.state === 'operational' && o.powered) lights.push({ x: o.x + 0.5, y: o.y + 0.5, z: 0, r: 5.5, a: 1, warm: '#ffe0a0' });
      if (o.type === 'generator' && o.state === 'operational' && o.data.running) lights.push({ x: o.x + 1.3, y: o.y + 1.8, z: 0, r: 1.6, a: 0.6, warm: '#c0ffb0' });
      if (o.type === 'workbench' && o.state === 'operational' && o.powered) lights.push({ x: o.x + 1, y: o.y + 0.8, z: 0, r: 2.6, a: 0.85, warm: '#ffe7b0' });
      if (o.type === 'radio' && o.state === 'operational' && o.powered) lights.push({ x: o.x + 0.5, y: o.y + 0.9, z: 0, r: 1.2, a: 0.6, warm: '#a0ffa0' });
      if (o.type === 'purifier' && o.powered) lights.push({ x: o.x + 0.5, y: o.y + 0.9, z: 0, r: 1.2, a: 0.5, warm: '#ffb070' });
      if (o.type === 'forklift' && o.state === 'operational' && !o.data.away) lights.push({ x: o.x + 0.5, y: o.y + 2.2, z: 0, r: 1.8, a: 0.6, warm: '#ffe0a0' });
    }
    for (const f of FIRES) lights.push({ x: f.x, y: f.y, z: f.z, r: 2.4, a: 0.7, warm: '#ff8a3a' });
    if (powered) {
      // Bare bulbs in the buildings when there's power in the system.
      lights.push({ x: 8.5, y: 7.5, z: 0, r: 4.5, a: 0.8, warm: '#ffd590' }, { x: 7, y: 17.5, z: 0, r: 3.6, a: 0.75, warm: '#ffd590' }, { x: 18, y: 6.5, z: 0, r: 3.4, a: 0.75, warm: '#ffd590' });
    }
    // Every survivor carries a little torchlight glow so they stay readable.
    for (const s of state.survivors) if (s.alive && !s.away && s.activity !== 'sleeping') lights.push({ x: s.x, y: s.y, z: 0, r: 1.1, a: 0.45, warm: '#ffcf8a' });
    for (const l of lights) {
      const w = iso(l.x, l.y, l.z);
      const s = cam.toScreen(w.x, w.y);
      const rad = l.r * 34 * cam.zoom * k;
      const flick = l.r > 3 ? 1 : 0.9 + Math.sin(t * 7 + l.x) * 0.1;
      const g = L.createRadialGradient(s.x * k, s.y * k, 0, s.x * k, s.y * k, rad);
      g.addColorStop(0, `rgba(0,0,0,${l.a * flick})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      L.fillStyle = g;
      L.beginPath();
      L.ellipse(s.x * k, s.y * k, rad, rad * 0.62, 0, 0, Math.PI * 2);
      L.fill();
    }
    ctx.drawImage(this.light, 0, 0, cam.width, cam.height);
    // Warm additive glow.
    ctx.globalCompositeOperation = 'lighter';
    for (const l of lights) {
      if (l.r < 2) continue;
      const w = iso(l.x, l.y, l.z);
      const s = cam.toScreen(w.x, w.y);
      const rad = l.r * 26 * cam.zoom;
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, rad);
      g.addColorStop(0, rgba(l.warm, 0.16 * night));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, rad, rad * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- overlays

  private drawOverlays(ctx: Ctx, state: GameState, view: ViewState, t: number): void {
    const cam = this.camera;
    const showAll = cam.zoom > 0.6;
    for (const o of state.objects) {
      if (o.state === 'dismantled' || o.data.away) continue;
      const job = state.jobs.find((j) => j.targetId === o.id);
      const h = objectHeight(o);
      const w = iso(o.x + o.w / 2, o.y + o.h / 2, h + 10);
      const s = cam.toScreen(w.x, w.y);
      if (s.x < -40 || s.y < -40 || s.x > cam.width + 40 || s.y > cam.height + 40) continue;
      let badge: { color: string; glyph: Glyph } | null = null;
      const hasActions = ['broken', 'damaged', 'flooded'].includes(o.state) && o.type !== 'planter';
      if (hasActions && OBJECT_DEFS[o.type] && o.type !== 'shelf') badge = { color: '#e8503a', glyph: 'wrench' };
      else if (o.state === 'operational' && o.on && (OBJECT_DEFS[o.type].draw ?? 0) > 0 && !o.powered && consumerDemand(state, o) > 0) badge = { color: '#e8b13a', glyph: 'bolt' };
      else if (o.type === 'planter' && o.state === 'growing' && (o.data.moisture ?? 0) < 25) badge = { color: '#4aa3d8', glyph: 'drop' };
      else if (o.type === 'planter' && o.state === 'ready') badge = { color: '#7cc04a', glyph: 'check' };
      else if (o.type === 'planter' && (o.state === 'overgrown' || o.state === 'damaged')) badge = { color: '#a08a5a', glyph: 'wrench' };
      else if (o.type === 'generator' && o.state === 'operational' && o.condition < 40) badge = { color: '#e8b13a', glyph: 'wrench' };
      if (job) {
        const frac = Math.min(1, job.progress / Math.max(1, job.required));
        drawProgress(ctx, s.x, s.y - 2, frac, job.phase === 'work' ? '#f2b544' : 'rgba(242,181,68,0.45)', job.blockedReason ? '#e8503a' : null);
      } else if (badge && (showAll || view.selectedObject === o.id)) {
        drawBadge(ctx, s.x, s.y - 4 + Math.sin(t * 3 + o.x) * 1.5, badge.color, badge.glyph);
      }
    }
    // Names over survivors when zoomed in or selected.
    ctx.font = '600 11px "Barlow Condensed", system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const s of state.survivors) {
      if (!s.alive || s.away) continue;
      if (view.selectedSurvivor !== s.id && cam.zoom < 1.25) continue;
      const w = iso(s.x, s.y, 40);
      const p = cam.toScreen(w.x, w.y);
      const name = s.name.split(' ')[0];
      const tw = ctx.measureText(name).width + 10;
      ctx.fillStyle = 'rgba(20,17,14,0.75)';
      roundRect(ctx, p.x - tw / 2, p.y - 14, tw, 15, 4);
      ctx.fill();
      ctx.fillStyle = view.selectedSurvivor === s.id ? '#f2b544' : '#e8e2d6';
      ctx.fillText(name, p.x, p.y - 3);
    }
    ctx.textAlign = 'left';
  }
}

type Glyph = 'wrench' | 'bolt' | 'drop' | 'check';

function drawBadge(ctx: Ctx, x: number, y: number, color: string, glyph: Glyph): void {
  ctx.fillStyle = 'rgba(15,12,10,0.7)';
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  switch (glyph) {
    case 'wrench':
      ctx.moveTo(x - 3.5, y + 3.5);
      ctx.lineTo(x + 1.5, y - 1.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x + 2.5, y - 2.5, 2.2, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'bolt':
      ctx.moveTo(x + 1, y - 5);
      ctx.lineTo(x - 3, y + 1);
      ctx.lineTo(x + 0.5, y + 1);
      ctx.lineTo(x - 1, y + 5);
      ctx.lineTo(x + 3, y - 1);
      ctx.lineTo(x - 0.5, y - 1);
      ctx.closePath();
      ctx.fill();
      break;
    case 'drop':
      ctx.moveTo(x, y - 5);
      ctx.quadraticCurveTo(x + 4.5, y + 1, x, y + 4);
      ctx.quadraticCurveTo(x - 4.5, y + 1, x, y - 5);
      ctx.fill();
      break;
    case 'check':
      ctx.moveTo(x - 3.5, y);
      ctx.lineTo(x - 1, y + 3);
      ctx.lineTo(x + 4, y - 3);
      ctx.stroke();
      break;
  }
}

function drawProgress(ctx: Ctx, x: number, y: number, frac: number, color: string, warn: string | null): void {
  const w = 34;
  ctx.fillStyle = 'rgba(15,12,10,0.75)';
  roundRect(ctx, x - w / 2 - 2, y - 4, w + 4, 8, 4);
  ctx.fill();
  ctx.fillStyle = warn ?? color;
  roundRect(ctx, x - w / 2, y - 2, Math.max(3, w * frac), 4, 2);
  ctx.fill();
}

export function objectHeight(o: WorldObject): number {
  switch (o.type) {
    case 'waterTank': return 70;
    case 'windTurbine': return 96;
    case 'lamp': return 72;
    case 'generator': return o.reinforced ? 62 : 46;
    case 'forklift': return 58;
    case 'workbench': return 44;
    case 'storageRack':
    case 'shelf': return 44;
    case 'gate': return 40;
    case 'rainCatcher': return 34;
    case 'purifier':
    case 'sandFilter': return 34;
    case 'scrapPile': return 18;
    case 'planter': return o.reinforced ? 32 : 22;
    case 'depot': return 40;
    case 'wreckedCar': return 30;
    default: return 22;
  }
}
