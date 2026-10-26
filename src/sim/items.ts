import type { ItemId, Items } from './types';

export interface ItemDef {
  id: ItemId;
  name: string;
  short: string;
  unit: string;
  /** Counts toward general storage capacity. Water lives in its own containers. */
  solid: boolean;
}

export const ITEMS: Record<ItemId, ItemDef> = {
  scrap: { id: 'scrap', name: 'Scrap metal', short: 'Scrap', unit: '', solid: true },
  mech: { id: 'mech', name: 'Mechanical parts', short: 'Mech', unit: '', solid: true },
  elec: { id: 'elec', name: 'Electrical parts', short: 'Elec', unit: '', solid: true },
  fuel: { id: 'fuel', name: 'Fuel', short: 'Fuel', unit: 'L', solid: true },
  battery: { id: 'battery', name: 'Battery cells', short: 'Cells', unit: '', solid: true },
  tools: { id: 'tools', name: 'Tool kits', short: 'Tools', unit: '', solid: true },
  food: { id: 'food', name: 'Food rations', short: 'Food', unit: '', solid: true },
  water: { id: 'water', name: 'Clean water', short: 'Water', unit: 'L', solid: false },
  rawWater: { id: 'rawWater', name: 'Untreated water', short: 'Raw', unit: 'L', solid: false },
  meds: { id: 'meds', name: 'Medical supplies', short: 'Meds', unit: '', solid: true },
  engine: { id: 'engine', name: 'Salvaged engine', short: 'Engine', unit: '', solid: true },
  filter: { id: 'filter', name: 'Filter cartridges', short: 'Filters', unit: '', solid: true },
};

export const ITEM_IDS = Object.keys(ITEMS) as ItemId[];

export function addItems(a: Items, b: Items, sign = 1): Items {
  const out: Items = { ...a };
  for (const k of Object.keys(b) as ItemId[]) {
    const v = (out[k] ?? 0) + sign * (b[k] ?? 0);
    if (Math.abs(v) < 1e-9) delete out[k];
    else out[k] = v;
  }
  return out;
}

export function isEmpty(items: Items): boolean {
  return (Object.keys(items) as ItemId[]).every((k) => !items[k]);
}

export function hasItems(have: Items, need: Items): boolean {
  return (Object.keys(need) as ItemId[]).every((k) => (have[k] ?? 0) + 1e-9 >= (need[k] ?? 0));
}

export function missingItems(have: Items, need: Items): Items {
  const out: Items = {};
  for (const k of Object.keys(need) as ItemId[]) {
    const short = (need[k] ?? 0) - (have[k] ?? 0);
    if (short > 1e-9) out[k] = short;
  }
  return out;
}

export function describeItems(items: Items): string {
  const parts = (Object.keys(items) as ItemId[])
    .filter((k) => (items[k] ?? 0) > 0)
    .map((k) => {
      const v = items[k] ?? 0;
      const n = Number.isInteger(v) ? v : v.toFixed(1);
      return `${n}${ITEMS[k].unit} ${ITEMS[k].short.toLowerCase()}`;
    });
  return parts.length ? parts.join(', ') : 'nothing';
}

export function solidCount(items: Items): number {
  let n = 0;
  for (const k of Object.keys(items) as ItemId[]) if (ITEMS[k].solid) n += items[k] ?? 0;
  return n;
}
