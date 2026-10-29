import { describe, expect, it } from 'vitest';
import { continueEndless, footprintBlocked, newGame, settleDown, step } from '../src/sim/sim';
import { killSurvivor } from '../src/sim/survivors';
import { adjustBond, bond, grieve, socialWork, RIVAL } from '../src/sim/social';
import { workRate } from '../src/sim/jobs';
import { mods } from '../src/sim/catastrophes';
import { objectiveTarget } from '../src/sim/scenario';
import { deserialize, serialize } from '../src/sim/save';
import { END_MINUTE, MINUTES_PER_DAY } from '../src/sim/time';
import type { GameState, Job } from '../src/sim/types';
import { playBot } from './bot';

const loose = (s: GameState) => s.objects.filter((o) => o.type === 'scrapPile' || o.type === 'wreckedCar').map((o) => `${o.type}@${o.x},${o.y}`).sort().join(' ');

describe('seeded layout', () => {
  it('scatters salvage differently per seed and identically for the same seed', () => {
    expect(loose(newGame(11))).toBe(loose(newGame(11)));
    const layouts = new Set([11, 12, 13, 14, 15].map((n) => loose(newGame(n))));
    expect(layouts.size).toBeGreaterThan(3);
  });

  it('only places heaps where they block nothing', () => {
    for (const seed of [3, 8, 21, 34, 55]) {
      const s = newGame(seed, { catastrophe: 'quake' });
      for (const o of s.objects.filter((x) => x.type === 'scrapPile' || x.type === 'wreckedCar')) {
        const others = s.objects.filter((x) => x !== o);
        const view = { ...s, objects: others };
        expect(footprintBlocked(view, o.w, o.h, o.x, o.y), `${o.id} seed ${seed}`).toBeNull();
      }
    }
  });
});

describe('relationships', () => {
  it('starts symmetric, with at least one friendship and one rivalry', () => {
    const s = newGame(9);
    const t = s.survivors;
    for (const a of t) for (const b of t) if (a !== b) expect(bond(a, b)).toBe(bond(b, a));
    const all = t.flatMap((a) => t.filter((b) => b !== a).map((b) => bond(a, b)));
    expect(Math.max(...all)).toBeGreaterThanOrEqual(50);
    expect(Math.min(...all)).toBeLessThanOrEqual(RIVAL);
  });

  it('makes grief hit closest friends hardest', () => {
    const s = newGame(9);
    const [dead, friend, stranger] = s.survivors;
    adjustBond(dead, friend, 90 - bond(dead, friend));
    adjustBond(dead, stranger, 0 - bond(dead, stranger));
    friend.morale = stranger.morale = 60;
    dead.alive = false;
    grieve(s, dead);
    expect(60 - friend.morale).toBeGreaterThan(60 - stranger.morale + 20);
  });

  it('speeds up friends working side by side and slows rivals', () => {
    const s = newGame(9);
    const [a, b] = s.survivors;
    a.x = b.x = 15.5;
    a.y = b.y = 15.5;
    b.activity = 'working';
    adjustBond(a, b, 80 - bond(a, b));
    expect(socialWork(s, a)).toBeGreaterThan(1);
    adjustBond(a, b, -40 - bond(a, b));
    expect(socialWork(s, a)).toBeLessThan(1);
    const job = { kind: 'build', skill: null, exposed: false, targetId: '', actionId: '' } as unknown as Job;
    expect(workRate(s, a, job)).toBeLessThan(1);
  });

  it('a death no longer costs everyone the same morale', () => {
    const s = newGame(4);
    for (const x of s.survivors) x.morale = 60;
    killSurvivor(s, s.survivors[0], 'testing');
    const drops = s.survivors.slice(1).map((x) => 60 - x.morale);
    expect(new Set(drops.map((d) => Math.round(d))).size).toBeGreaterThan(1);
  });
});

describe('endless mode', () => {
  function finished(): GameState {
    const s = newGame(42, { catastrophe: 'storm' });
    for (let h = 0; h < 7 * 24 + 2 && !s.result; h++) playBot(s, 60);
    return s;
  }

  it('lets a surviving settlement keep going past Day 7 with rising strain, then settle', () => {
    const s = finished();
    expect(s.result?.status).toBe('won');
    const needs = mods(s).needs;
    expect(continueEndless(s).ok).toBe(true);
    expect(s.result).toBeNull();
    for (let i = 0; i < 2 * MINUTES_PER_DAY && !s.result; i++) {
      if (s.events.pending) s.events.pending = null;
      step(s);
    }
    expect(s.minute).toBeGreaterThan(END_MINUTE + MINUTES_PER_DAY);
    expect(mods(s).needs).toBeGreaterThan(needs);
    expect(s.weather.rainWindows.some((r) => r.start > END_MINUTE)).toBe(true);
    const round = deserialize(serialize(s));
    expect(round.ok && round.state.flags.endless).toBe(true);
    if (!s.result) {
      expect(settleDown(s).ok).toBe(true);
      expect(s.result!.lines[0]).toMatch(/Endured \d+ days/);
    }
  });

  it('refuses to continue a lost game', () => {
    const s = newGame(42);
    s.events.pending = null;
    for (const x of s.survivors) killSurvivor(s, x, 'testing');
    step(s);
    expect(s.result?.status).toBe('lost');
    expect(continueEndless(s).ok).toBe(false);
  });
});

describe('objective target', () => {
  it('points at the generator at the start of Storm Season, and at the rubble when someone is trapped', () => {
    expect(objectiveTarget(newGame(7))).toEqual({ kind: 'object', id: 'generator' });
    const q = newGame(7, { catastrophe: 'quake' });
    const t = objectiveTarget(q)!;
    expect(q.objects.find((o) => o.id === t.id)?.type).toBe('rubble');
  });
});

describe('Brutal', () => {
  it('brings the Storm Season storm a day early', () => {
    const n = newGame(7, { catastrophe: 'storm', difficulty: 'normal' });
    const h = newGame(7, { catastrophe: 'storm', difficulty: 'hard' });
    expect(n.weather.stormStart - h.weather.stormStart).toBe(20 * 60);
    expect(h.world.climax.at).toBe(h.weather.stormStart);
    expect(mods(h).loot).toBeLessThan(mods(n).loot);
  });
});
