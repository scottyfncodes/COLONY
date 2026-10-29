import type { CatastropheId, Difficulty, GameState } from '../sim/types';
import { dayOf } from '../sim/time';

// A record of finished runs, kept in this browser. Feeds personal bests on the scenario
// screen and unlocks Brutal once a settlement has been made to work on Standard.

export interface RunRecord {
  at: number;
  catastrophe: CatastropheId;
  difficulty: Difficulty;
  sandbox: boolean;
  status: 'won' | 'lost';
  grade: string;
  alive: number;
  total: number;
  days: number;
  endless: boolean;
}

interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const KEY = 'colony.history';
const RANK = ['Settlement lost', 'Abandoned', 'Holding on', 'Functioning settlement', 'Thriving settlement'];

export function loadHistory(store: KV): RunRecord[] {
  try {
    const v = JSON.parse(store.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((r) => r && typeof r.grade === 'string') : [];
  } catch {
    return [];
  }
}

export function recordRun(store: KV, s: GameState): RunRecord[] {
  const r = s.result!;
  const list = loadHistory(store);
  list.push({
    at: Date.now(),
    catastrophe: s.world.catastrophe,
    difficulty: s.world.difficulty,
    sandbox: s.world.mode === 'sandbox',
    status: r.status === 'won' ? 'won' : 'lost',
    grade: r.grade,
    alive: s.survivors.filter((x) => x.alive).length,
    total: s.survivors.length,
    days: dayOf(s.minute) - 1,
    endless: !!s.flags.endless,
  });
  try {
    store.setItem(KEY, JSON.stringify(list.slice(-100)));
  } catch {
    /* storage full or unavailable */
  }
  return list;
}

export const gradeRank = (g: string) => Math.max(0, RANK.indexOf(g));

/** Brutal is earned: a Functioning or Thriving settlement on Standard or Brutal, outside the sandbox. */
export function brutalUnlocked(list: RunRecord[]): boolean {
  return list.some((r) => !r.sandbox && r.difficulty !== 'easy' && gradeRank(r.grade) >= 3);
}

/** Best result for a scenario: highest grade, then most days. */
export function bestFor(list: RunRecord[], c: CatastropheId): RunRecord | null {
  let best: RunRecord | null = null;
  for (const r of list) {
    if (r.catastrophe !== c || r.sandbox) continue;
    if (!best || gradeRank(r.grade) > gradeRank(best.grade) || (gradeRank(r.grade) === gradeRank(best.grade) && r.days > best.days)) best = r;
  }
  return best;
}

export function shortGrade(g: string): string {
  return g.replace(' settlement', '');
}
