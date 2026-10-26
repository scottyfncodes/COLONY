import type { GameState, ObjectType, Point, WorldObject } from './types';

// The compound is a fixed grid. Tile types never change during play; what
// changes is the set of objects standing on tiles.

export const MAP_W = 32;
export const MAP_H = 32;

export const enum Tile {
  Dirt = 0,
  Concrete = 1,
  Asphalt = 2,
  Floor = 3,
  Soil = 4,
  Grass = 5,
  Wall = 6,
  Fence = 7,
  Pad = 8,
  Road = 9,
}

export interface Building {
  id: string;
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  doors: Point[];
}

export const BUILDINGS: Building[] = [
  { id: 'warehouse', name: 'Warehouse', x0: 4, y0: 4, x1: 12, y1: 11, doors: [{ x: 8, y: 11 }, { x: 12, y: 8 }] },
  {
    id: 'workshop',
    name: 'Workshop',
    x0: 15,
    y0: 4,
    x1: 21,
    y1: 9,
    doors: [{ x: 17, y: 9 }, { x: 18, y: 9 }, { x: 19, y: 9 }],
  },
  { id: 'bunkhouse', name: 'Bunkhouse', x0: 4, y0: 14, x1: 10, y1: 20, doors: [{ x: 10, y: 17 }] },
];

export const GATE_TILES: Point[] = [
  { x: 29, y: 15 },
  { x: 29, y: 16 },
];
export const GATE_OUTSIDE: Point = { x: 31, y: 15 };
export const GATE_INSIDE: Point = { x: 27, y: 15 };

export interface Zone {
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const ZONES: Zone[] = [
  { name: 'Generator yard', x0: 23, y0: 4, x1: 27, y1: 9 },
  { name: 'Water works', x0: 22, y0: 12, x1: 27, y1: 19 },
  { name: 'Growing plot', x0: 13, y0: 22, x1: 19, y1: 27 },
];

function buildTiles(): Uint8Array {
  const t = new Uint8Array(MAP_W * MAP_H);
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      let v: Tile = Tile.Concrete;
      const outside = x < 2 || x > 29 || y < 2 || y > 29;
      if (outside) v = (x * 7 + y * 13) % 5 === 0 ? Tile.Grass : Tile.Dirt;
      else if (x === 2 || x === 29 || y === 2 || y === 29) v = Tile.Fence;
      else if (x >= 13 && x <= 21 && y >= 11 && y <= 20) v = Tile.Asphalt;
      t[y * MAP_W + x] = v;
    }
  }
  const set = (x: number, y: number, v: Tile) => (t[y * MAP_W + x] = v);
  // Road out of the gate
  for (let x = 22; x < MAP_W; x++) for (let y = 15; y <= 16; y++) set(x, y, x >= 29 ? Tile.Road : Tile.Asphalt);
  for (const g of GATE_TILES) set(g.x, g.y, Tile.Road);
  // Pads
  for (let y = 4; y <= 9; y++) for (let x = 23; x <= 27; x++) set(x, y, Tile.Pad);
  for (let y = 12; y <= 19; y++) for (let x = 23; x <= 27; x++) if (y < 15 || y > 16) set(x, y, Tile.Pad);
  // Growing plot
  for (let y = 22; y <= 27; y++) for (let x = 13; x <= 19; x++) set(x, y, Tile.Soil);
  // Buildings
  for (const b of BUILDINGS) {
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const edge = x === b.x0 || x === b.x1 || y === b.y0 || y === b.y1;
        set(x, y, edge ? Tile.Wall : Tile.Floor);
      }
    }
    for (const d of b.doors) set(d.x, d.y, Tile.Floor);
  }
  // A few grass patches inside for texture
  for (const [x, y] of [
    [3, 26], [4, 27], [3, 27], [26, 27], [27, 26], [27, 27], [12, 27], [3, 12], [21, 3], [22, 3],
  ] as const) set(x, y, Tile.Grass);
  return t;
}

export const TILES = buildTiles();

export function tileAt(x: number, y: number): Tile {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return Tile.Wall;
  return TILES[y * MAP_W + x] as Tile;
}

export function isSheltered(x: number, y: number): boolean {
  return tileAt(Math.floor(x), Math.floor(y)) === Tile.Floor;
}

export function buildingAt(x: number, y: number): Building | null {
  for (const b of BUILDINGS) if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return b;
  return null;
}

export function inCompound(x: number, y: number): boolean {
  return x > 2 && x < 29 && y > 2 && y < 29;
}

function baseWalkable(x: number, y: number): boolean {
  const v = tileAt(x, y);
  return v !== Tile.Wall && v !== Tile.Fence;
}

/** Objects that occupy tiles but can be walked through. */
const PASSABLE: ObjectType[] = ['gate'];

export function objectBlocks(o: WorldObject): boolean {
  if (PASSABLE.includes(o.type)) return false;
  if (o.state === 'dismantled' || o.state === 'removed') return false;
  return true;
}

export function occupancy(state: GameState): Uint8Array {
  const occ = new Uint8Array(MAP_W * MAP_H);
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) if (!baseWalkable(x, y)) occ[y * MAP_W + x] = 1;
  for (const o of state.objects) {
    if (!objectBlocks(o)) continue;
    for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) occ[y * MAP_W + x] = 2;
  }
  return occ;
}

export function walkable(occ: Uint8Array, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false;
  return occ[y * MAP_W + x] === 0;
}

/** A* over the tile grid with 8-way movement and no corner cutting. Returns tile centres excluding the start. */
export function findPath(occ: Uint8Array, from: Point, to: Point): Point[] | null {
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y);
  const tx = Math.floor(to.x);
  const ty = Math.floor(to.y);
  if (!walkable(occ, tx, ty)) return null;
  if (sx === tx && sy === ty) return [{ x: tx + 0.5, y: ty + 0.5 }];
  const N = MAP_W * MAP_H;
  const g = new Float32Array(N).fill(Infinity);
  const f = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const open: number[] = [];
  const s = sy * MAP_W + sx;
  const goal = ty * MAP_W + tx;
  const h = (i: number) => {
    const dx = Math.abs((i % MAP_W) - tx);
    const dy = Math.abs(Math.floor(i / MAP_W) - ty);
    return Math.max(dx, dy) + 0.41 * Math.min(dx, dy);
  };
  g[s] = 0;
  f[s] = h(s);
  open.push(s);
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
    const cur = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % MAP_W;
    const cy = Math.floor(cur / MAP_W);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        // Start tile may be blocked (survivor standing in a doorway that got built over); allow leaving it.
        if (!walkable(occ, nx, ny)) continue;
        if (dx && dy && (!walkable(occ, cx + dx, cy) || !walkable(occ, cx, cy + dy))) continue;
        const ni = ny * MAP_W + nx;
        if (closed[ni]) continue;
        const ng = g[cur] + (dx && dy ? 1.414 : 1);
        if (ng < g[ni]) {
          g[ni] = ng;
          f[ni] = ng + h(ni);
          came[ni] = cur;
          open.push(ni);
        }
      }
    }
  }
  if (came[goal] === -1) return null;
  const out: Point[] = [];
  let c = goal;
  while (c !== s && c !== -1) {
    out.push({ x: (c % MAP_W) + 0.5, y: Math.floor(c / MAP_W) + 0.5 });
    c = came[c];
  }
  out.reverse();
  return out;
}

export function pathLength(path: Point[], from: Point): number {
  let len = 0;
  let px = from.x;
  let py = from.y;
  for (const p of path) {
    len += Math.hypot(p.x - px, p.y - py);
    px = p.x;
    py = p.y;
  }
  return len;
}

/** Walkable tiles orthogonally adjacent to an object's footprint. */
export function accessTiles(occ: Uint8Array, o: { x: number; y: number; w: number; h: number }): Point[] {
  const out: Point[] = [];
  for (let x = o.x; x < o.x + o.w; x++) {
    out.push({ x, y: o.y - 1 }, { x, y: o.y + o.h });
  }
  for (let y = o.y; y < o.y + o.h; y++) {
    out.push({ x: o.x - 1, y }, { x: o.x + o.w, y });
  }
  return out.filter((p) => walkable(occ, p.x, p.y));
}

/** Find the nearest walkable tile to a point (used to rescue survivors standing on newly blocked tiles). */
export function nearestWalkable(occ: Uint8Array, p: Point): Point {
  const px = Math.floor(p.x);
  const py = Math.floor(p.y);
  if (walkable(occ, px, py)) return { x: px, y: py };
  for (let r = 1; r < 10; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (walkable(occ, px + dx, py + dy)) return { x: px + dx, y: py + dy };
      }
    }
  }
  return { ...GATE_INSIDE };
}

/** Flood fill reachability from a tile. */
export function reachable(occ: Uint8Array, from: Point): Uint8Array {
  const seen = new Uint8Array(MAP_W * MAP_H);
  const stack = [Math.floor(from.y) * MAP_W + Math.floor(from.x)];
  while (stack.length) {
    const c = stack.pop()!;
    if (seen[c]) continue;
    const x = c % MAP_W;
    const y = Math.floor(c / MAP_W);
    if (!walkable(occ, x, y)) continue;
    seen[c] = 1;
    if (x > 0) stack.push(c - 1);
    if (x < MAP_W - 1) stack.push(c + 1);
    if (y > 0) stack.push(c - MAP_W);
    if (y < MAP_H - 1) stack.push(c + MAP_W);
  }
  return seen;
}
