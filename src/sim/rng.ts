import type { GameState } from './types';

// Mulberry32: small, fast, deterministic. State lives in GameState so
// saves and replays reproduce identical outcomes.
export function nextRandom(state: GameState): number {
  let t = (state.rngState = (state.rngState + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function chance(state: GameState, p: number): boolean {
  return nextRandom(state) < p;
}

export function randInt(state: GameState, min: number, max: number): number {
  return min + Math.floor(nextRandom(state) * (max - min + 1));
}

/** Stable hash noise in [0,1) for a seed and an integer — used for wind etc. without consuming RNG. */
export function hashNoise(seed: number, n: number): number {
  let h = (seed ^ Math.imul(n, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
