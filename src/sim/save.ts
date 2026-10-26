import { ITEM_IDS } from './items';
import { defaultWorld, SAVE_VERSION } from './setup';
import type { GameState } from './types';

export const SAVE_KEY = 'colony.save';

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

export type LoadResult = { ok: true; state: GameState } | { ok: false; reason: string };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function validItems(v: unknown): boolean {
  if (!isObj(v)) return false;
  for (const [k, n] of Object.entries(v)) {
    if (!ITEM_IDS.includes(k as never)) return false;
    if (!isNum(n) || n < -1e-6) return false;
  }
  return true;
}

/** Parse and validate a save. Never throws; malformed or incompatible data is rejected with a reason. */
export function deserialize(text: string | null | undefined): LoadResult {
  if (!text) return { ok: false, reason: 'No save found.' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'Save data is corrupted.' };
  }
  if (!isObj(raw)) return { ok: false, reason: 'Save data is corrupted.' };
  const s = migrate(raw);
  if (!s) return { ok: false, reason: `Save is from an incompatible version (${String(raw.version)}).` };
  const problems: string[] = [];
  if (!isNum(s.minute) || s.minute < 0) problems.push('time');
  if (!isNum(s.seed) || !isNum(s.rngState) || !isNum(s.nextId)) problems.push('rng');
  if (!Array.isArray(s.survivors) || s.survivors.length === 0) problems.push('survivors');
  else
    for (const v of s.survivors as unknown[]) {
      if (!isObj(v) || typeof v.id !== 'string' || !isNum(v.x) || !isNum(v.y) || !isNum(v.health) || !Array.isArray(v.path)) {
        problems.push('survivor');
        break;
      }
    }
  if (!Array.isArray(s.objects)) problems.push('objects');
  else
    for (const o of s.objects as unknown[]) {
      if (!isObj(o) || typeof o.id !== 'string' || typeof o.type !== 'string' || !isNum(o.x) || !isNum(o.y) || !validItems(o.contents)) {
        problems.push('object');
        break;
      }
    }
  if (!Array.isArray(s.jobs) || !(s.jobs as unknown[]).every((j) => isObj(j) && validItems(j.staged) && validItems(j.inputs))) problems.push('jobs');
  if (!validItems(s.inventory)) problems.push('inventory');
  if (!isObj(s.ledger) || !validItems((s.ledger as Record<string, unknown>).produced) || !validItems((s.ledger as Record<string, unknown>).consumed)) problems.push('ledger');
  if (!isObj(s.world) || typeof (s.world as Record<string, unknown>).catastrophe !== 'string') problems.push('world');
  if (!isObj(s.weather) || !isObj(s.locations) || !Array.isArray(s.expeditions) || !isObj(s.events) || !Array.isArray(s.log) || !isObj(s.stats)) problems.push('structure');
  if (problems.length) return { ok: false, reason: `Save data is damaged (${problems.join(', ')}).` };
  return { ok: true, state: s as unknown as GameState };
}

/** Upgrade older saves where possible. Returns null for unknown versions. */
function migrate(raw: Record<string, unknown>): Record<string, unknown> | null {
  let v = raw.version;
  if (v === 3) {
    // v3 → v4: catastrophes. Older games are the original Storm Season scenario.
    if (!isObj(raw.weather) || !Array.isArray(raw.survivors)) return null;
    raw.world = defaultWorld(raw.weather as never);
    const w = raw.world as { climax: { resolved: boolean; known: boolean } };
    w.climax.resolved = !!(raw.weather as Record<string, unknown>).stormResolved;
    w.climax.known = !!(raw.weather as Record<string, unknown>).stormForecastKnown;
    for (const s of raw.survivors as Record<string, unknown>[]) {
      if (!isObj(s)) continue;
      s.dose ??= 0;
      s.illness ??= null;
      s.trapped ??= false;
      s.quarantined ??= false;
    }
    raw.version = v = 4;
  }
  if (v === SAVE_VERSION) return raw;
  return null;
}

export interface Storage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export function saveTo(storage: Storage, state: GameState): boolean {
  try {
    storage.setItem(SAVE_KEY, serialize(state));
    return true;
  } catch {
    return false;
  }
}

export function loadFrom(storage: Storage): LoadResult {
  try {
    return deserialize(storage.getItem(SAVE_KEY));
  } catch {
    return { ok: false, reason: 'Storage is unavailable.' };
  }
}

export function clearSave(storage: Storage): void {
  try {
    storage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}
