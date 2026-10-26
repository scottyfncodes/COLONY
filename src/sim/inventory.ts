import { addItems, hasItems, ITEMS, solidCount } from './items';
import type { GameState, ItemId, Items, LogEntry } from './types';

// Single authoritative resource store. Every change goes through these helpers:
//  - produce/consume change the world total and are recorded in the ledger;
//  - take/deposit move items between the store and something that carries them
//    (a worker's staged materials, an expedition pack) without changing the total.

export function log(state: GameState, text: string, tone: LogEntry['tone'] = 'info'): void {
  state.log.push({ t: state.minute, text, tone });
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

export function count(state: GameState, id: ItemId): number {
  return state.inventory[id] ?? 0;
}

export function storageCapacity(state: GameState): number {
  let cap = 80;
  for (const o of state.objects) if (o.type === 'storageRack' && o.state === 'operational') cap += 40;
  return cap;
}

export function rawCapacity(state: GameState): number {
  let cap = 20; // barrels by the well
  for (const o of state.objects) {
    if (o.type !== 'waterTank') continue;
    if (o.state === 'operational') cap += 300;
    else if (o.state === 'damaged') cap += 40;
  }
  return cap;
}

export function cleanCapacity(_state: GameState): number {
  return 80; // jerry cans and bottles in the warehouse
}

export function capacityFor(state: GameState, id: ItemId): number {
  if (id === 'water') return cleanCapacity(state);
  if (id === 'rawWater') return rawCapacity(state);
  return Infinity;
}

/** Remaining room for an item in the store. Solids share the general storage pool. */
export function roomFor(state: GameState, id: ItemId): number {
  if (ITEMS[id].solid) return Math.max(0, storageCapacity(state) - solidCount(state.inventory));
  return Math.max(0, capacityFor(state, id) - count(state, id));
}

function record(target: Items, items: Items): void {
  for (const k of Object.keys(items) as ItemId[]) {
    const v = items[k] ?? 0;
    if (v > 0) target[k] = (target[k] ?? 0) + v;
  }
}

/** Create items in a holder (default: the store). Returns what actually fit when targeting the store. */
export function produce(state: GameState, items: Items, into: Items = state.inventory): Items {
  const added: Items = {};
  for (const k of Object.keys(items) as ItemId[]) {
    let v = items[k] ?? 0;
    if (v <= 0) continue;
    if (into === state.inventory) v = Math.min(v, roomFor(state, k));
    if (v <= 0) continue;
    into[k] = (into[k] ?? 0) + v;
    added[k] = v;
  }
  record(state.ledger.produced, added);
  return added;
}

/** Destroy items from a holder (default: the store). Throws on overdraw — callers must check first. */
export function consume(state: GameState, items: Items, from: Items = state.inventory): void {
  if (!hasItems(from, items)) throw new Error('consume: insufficient items');
  for (const k of Object.keys(items) as ItemId[]) {
    const v = items[k] ?? 0;
    if (v <= 0) continue;
    const left = (from[k] ?? 0) - v;
    if (left <= 1e-9) delete from[k];
    else from[k] = left;
  }
  record(state.ledger.consumed, items);
}

/** Consume up to `amount` of an item; returns how much was consumed. */
export function consumeUpTo(state: GameState, id: ItemId, amount: number, from: Items = state.inventory): number {
  const v = Math.min(amount, from[id] ?? 0);
  if (v > 0) consume(state, { [id]: v }, from);
  return v;
}

/** Move items from the store into a carrier. Returns false (and moves nothing) if not all are available. */
export function take(state: GameState, items: Items, carrier: Items): boolean {
  if (!hasItems(state.inventory, items)) return false;
  for (const k of Object.keys(items) as ItemId[]) {
    const v = items[k] ?? 0;
    if (v <= 0) continue;
    const left = (state.inventory[k] ?? 0) - v;
    if (left <= 1e-9) delete state.inventory[k];
    else state.inventory[k] = left;
    carrier[k] = (carrier[k] ?? 0) + v;
  }
  return true;
}

/** Move everything a carrier holds into the store, as far as capacity allows. Returns the overflow (left in the carrier). */
export function deposit(state: GameState, carrier: Items): Items {
  for (const k of Object.keys(carrier) as ItemId[]) {
    const v = carrier[k] ?? 0;
    if (v <= 0) {
      delete carrier[k];
      continue;
    }
    const fit = Math.min(v, roomFor(state, k));
    if (fit > 0) {
      state.inventory[k] = (state.inventory[k] ?? 0) + fit;
      const left = v - fit;
      if (left <= 1e-9) delete carrier[k];
      else carrier[k] = left;
    }
  }
  return carrier;
}

/** Move all items from one carrier to another (no capacity limits). */
export function transferAll(from: Items, to: Items): void {
  for (const k of Object.keys(from) as ItemId[]) {
    const v = from[k] ?? 0;
    if (v > 0) to[k] = (to[k] ?? 0) + v;
    delete from[k];
  }
}

/** Sum of every item anywhere in the world: store, carried materials, packs, cargo, piles. */
export function worldTotal(state: GameState): Items {
  let total: Items = { ...state.inventory };
  for (const j of state.jobs) total = addItems(total, j.staged);
  for (const e of state.expeditions) {
    total = addItems(total, e.packed);
    total = addItems(total, e.cargo);
  }
  for (const o of state.objects) total = addItems(total, o.contents);
  return total;
}

export function canAfford(state: GameState, items: Items): boolean {
  return hasItems(state.inventory, items);
}
