import { log } from './inventory';
import { chance } from './rng';
import { hashNoise } from './rng';
import { first, presentSurvivors } from './survivors';
import type { GameState, Survivor } from './types';

// Relationships between survivors. Bonds run from -50 (bitter rivals) to 100 (inseparable),
// stay symmetric, and grow from time spent together in good conditions. They feed morale,
// work speed when friends or rivals work side by side, and grief when someone dies.

export const FRIEND = 50;
export const CLOSE = 70;
export const RIVAL = -15;

export function bond(a: Survivor, b: Survivor): number {
  return a.relationships[b.id] ?? 5;
}

export function adjustBond(a: Survivor, b: Survivor, delta: number): void {
  const v = Math.max(-50, Math.min(100, bond(a, b) + delta));
  a.relationships[b.id] = v;
  b.relationships[a.id] = v;
}

export function bondLabel(v: number): string | null {
  if (v >= CLOSE) return 'close friends';
  if (v >= FRIEND) return 'friends';
  if (v <= RIVAL) return 'rivals';
  return null;
}

/** Starting bonds for a new game: mostly mild, with one seeded friendship and one rivalry. */
export function seedBonds(state: GameState): void {
  const team = state.survivors;
  const pairs: [Survivor, Survivor][] = [];
  for (let i = 0; i < team.length; i++) for (let j = i + 1; j < team.length; j++) pairs.push([team[i], team[j]]);
  pairs.forEach(([a, b], k) => {
    const v = 8 + Math.floor(hashNoise(state.seed, 400 + k) * 30);
    a.relationships[b.id] = v;
    b.relationships[a.id] = v;
  });
  const pick = (n: number) => pairs[Math.floor(hashNoise(state.seed, n) * pairs.length)];
  const [fa, fb] = pick(431);
  adjustBond(fa, fb, 62 - bond(fa, fb));
  let r = pick(433);
  if (r[0] === fa && r[1] === fb) r = pairs[(pairs.indexOf(r) + 1) % pairs.length];
  adjustBond(r[0], r[1], -22 - bond(r[0], r[1]));
}

const near = (a: Survivor, b: Survivor, d: number) => Math.hypot(a.x - b.x, a.y - b.y) <= d;
const awake = (s: Survivor) => s.activity !== 'sleeping' && !s.quarantined && !s.trapped;

/** Hourly: time together builds bonds; hardship together breeds friction. */
export function tickSocial(state: GameState): void {
  const here = presentSurvivors(state);
  for (let i = 0; i < here.length; i++) {
    for (let j = i + 1; j < here.length; j++) {
      const a = here[i];
      const b = here[j];
      if (!awake(a) || !awake(b) || !near(a, b, 5)) continue;
      const together = a.activity === 'working' && b.activity === 'working' ? 0.5 : 0;
      if (a.morale >= 30 && b.morale >= 30) adjustBond(a, b, 0.6 + together);
      else if (a.morale < 25 && b.morale < 25 && chance(state, 0.25)) {
        adjustBond(a, b, -4);
        if (bond(a, b) <= RIVAL && chance(state, 0.5)) log(state, `${first(a)} and ${first(b)} snapped at each other. Tempers are short.`, 'warn');
      }
    }
  }
  // Surviving the worst together brings people closer, once.
  if (state.world.climax.resolved && !state.flags.bondedByClimax && state.stats.deaths.length === 0) {
    state.flags.bondedByClimax = true;
    for (let i = 0; i < here.length; i++) for (let j = i + 1; j < here.length; j++) adjustBond(here[i], here[j], 6);
  }
}

/** Morale offset from the company someone keeps at the compound. */
export function socialMorale(state: GameState, s: Survivor): number {
  if (s.away) return 0;
  let v = 0;
  for (const o of state.survivors) {
    if (o === s || !o.alive || o.away) continue;
    const b = bond(s, o);
    if (b >= FRIEND) v += (b - FRIEND + 20) / 10;
    else if (b <= RIVAL) v -= 3;
  }
  return Math.max(-6, Math.min(8, v));
}

/** Work speed multiplier from who is working nearby. */
export function socialWork(state: GameState, s: Survivor): number {
  let r = 1;
  for (const o of state.survivors) {
    if (o === s || !o.alive || o.away || o.activity !== 'working' || !near(s, o, 3)) continue;
    const b = bond(s, o);
    if (b >= FRIEND) r = Math.max(r, 1.1);
    else if (b <= RIVAL) r = Math.min(r, 0.92);
  }
  return r;
}

/** Everyone feels a death; those closest to the dead feel it most. */
export function grieve(state: GameState, dead: Survivor): void {
  let closest: Survivor | null = null;
  for (const o of state.survivors) {
    if (!o.alive || o === dead) continue;
    const b = Math.max(0, bond(o, dead));
    o.morale = Math.max(0, o.morale - (8 + b * 0.3));
    if (b >= FRIEND && (!closest || b > bond(closest, dead))) closest = o;
  }
  if (closest) log(state, `${first(closest)} takes ${first(dead)}’s death hard.`, 'bad');
}
