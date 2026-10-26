import { ITEMS, describeItems, isEmpty, solidCount } from './items';
import { canAfford, consume, deposit, log, produce, take, transferAll } from './inventory';
import { getSurvivor, newId, releaseJob, spillToCrate } from './jobs';
import { chance, randInt } from './rng';
import { first, stormActive, updateNeeds } from './survivors';
import { GATE_INSIDE } from './world';
import type { CommandResult, Expedition, GameState, ItemId, Items, LocationId } from './types';

export interface LocationDef {
  id: LocationId;
  name: string;
  blurb: string;
  legMinutes: number;
  searchMinutes: number;
  risk: number;
  /** Position on the regional map, 0..1. */
  map: { x: number; y: number };
  hint: string;
}

export const LOCATIONS: Record<LocationId, LocationDef> = {
  garage: {
    id: 'garage',
    name: 'Hollis Auto Garage',
    blurb: 'A two-bay garage on the old county road. Fuel, parts and tools, if nobody beat you to it.',
    legMinutes: 150,
    searchMinutes: 150,
    risk: 0.12,
    map: { x: 0.74, y: 0.2 },
    hint: 'Fuel · mechanical parts · tools · cells',
  },
  market: {
    id: 'market',
    name: 'Corner Market',
    blurb: 'A looted grocery two kilometres east. The shelves are bare, but stockrooms get overlooked.',
    legMinutes: 180,
    searchMinutes: 150,
    risk: 0.16,
    map: { x: 0.84, y: 0.56 },
    hint: 'Food · bottled water · medical supplies',
  },
  pumpStation: {
    id: 'pumpStation',
    name: 'Ridge Pump Station',
    blurb: 'A municipal pump house up the ridge. Electrical gear, filter media and a long walk.',
    legMinutes: 240,
    searchMinutes: 180,
    risk: 0.2,
    map: { x: 0.56, y: 0.86 },
    hint: 'Untreated water every visit · electrical parts · filters',
  },
};

export const MAX_TEAM = 3;
export const CARGO_PER_MEMBER = 8;
export const WATER_PER_MEMBER = 10;
/** Priority order when cargo space is limited. */
const LOOT_PRIORITY: ItemId[] = ['fuel', 'mech', 'elec', 'filter', 'meds', 'food', 'water', 'rawWater', 'battery', 'tools', 'scrap'];

export function vehicleAvailable(state: GameState): boolean {
  return state.objects.some((o) => o.type === 'forklift' && o.state === 'operational');
}

export function expeditionPlan(state: GameState, destination: LocationId, members: string[], packed: Items, vehicle: boolean) {
  const loc = LOCATIONS[destination];
  const team = members.map((id) => getSurvivor(state, id)!).filter(Boolean);
  const fast = team.length > 0 && team.every((s) => s.trait === 'lightFooted') ? 0.75 : team.some((s) => s.trait === 'lightFooted') ? 0.9 : 1;
  const leg = Math.round(loc.legMinutes * fast * (vehicle ? 0.75 : 1));
  const search = Math.round(loc.searchMinutes * (team.some((s) => s.role === 'Scavenger') ? 0.8 : 1));
  const cap = Math.round(team.length * CARGO_PER_MEMBER * (vehicle ? 1.6 : 1));
  const waterCap = Math.round(team.length * WATER_PER_MEMBER * (vehicle ? 1.6 : 1));
  const quality = searchQuality(state, members, packed);
  const waterNeeded = team.length * 3;
  return { leg, search, total: leg * 2 + search, cap, waterCap, quality, waterNeeded, loc };
}

export function searchQuality(state: GameState, members: string[], packed: Items): number {
  let q = 0;
  for (const id of members) {
    const s = getSurvivor(state, id);
    if (s) q += 0.5 + 0.25 * s.skills.scavenging;
  }
  if ((packed.tools ?? 0) > 0) q *= 1.35;
  return Math.min(1, 0.27 * q);
}

export function validateExpedition(state: GameState, destination: LocationId, members: string[], packed: Items, vehicle: boolean): string | null {
  if (!LOCATIONS[destination]) return 'Unknown destination.';
  if (stormActive(state)) return 'Nobody can travel in this storm.';
  if (!members.length) return 'Choose at least one survivor.';
  if (members.length > MAX_TEAM) return `At most ${MAX_TEAM} can go.`;
  if (new Set(members).size !== members.length) return 'Duplicate team member.';
  const present = state.survivors.filter((s) => s.alive && !s.away).length;
  if (present - members.length < 1) return 'Someone has to stay behind to keep the compound running.';
  for (const id of members) {
    const s = getSurvivor(state, id);
    if (!s || !s.alive) return 'A team member is unavailable.';
    if (s.away) return `${s.name} is already away.`;
    if (s.energy < 25) return `${first(s)} is too exhausted to travel.`;
    if (s.health < 35) return `${first(s)} is too badly hurt to travel.`;
  }
  if (vehicle && !vehicleAvailable(state)) return 'No working vehicle.';
  const need: Items = { ...packed };
  if (vehicle) need.fuel = (need.fuel ?? 0) + 1;
  if (!canAfford(state, need)) return `Not enough supplies: ${describeItems(need)}.`;
  for (const k of Object.keys(packed) as ItemId[]) if ((packed[k] ?? 0) < 0) return 'Invalid supplies.';
  return null;
}

export function startExpedition(state: GameState, destination: LocationId, members: string[], packed: Items, vehicle: boolean): CommandResult {
  const why = validateExpedition(state, destination, members, packed, vehicle);
  if (why) return { ok: false, message: why };
  const plan = expeditionPlan(state, destination, members, packed, vehicle);
  const exp: Expedition = {
    id: newId(state, 'x'),
    destination,
    members: [...members],
    packed: {},
    cargo: {},
    vehicle,
    phase: 'outbound',
    elapsed: 0,
    legMinutes: plan.leg,
    searchMinutes: plan.search,
    log: [],
    pendingDecision: null,
    bonusSearch: 0,
    startedAt: state.minute,
  };
  const need: Items = { ...packed };
  if (vehicle) need.fuel = (need.fuel ?? 0) + 1;
  take(state, need, exp.packed);
  if (vehicle) {
    // The vehicle burns its fuel on the way out.
    consume(state, { fuel: 1 }, exp.packed);
    const fl = state.objects.find((o) => o.type === 'forklift' && o.state === 'operational');
    if (fl) fl.data.away = 1;
  }
  for (const id of members) {
    const s = getSurvivor(state, id)!;
    const job = state.jobs.find((j) => j.id === s.jobId);
    if (job) releaseJob(state, job);
    s.jobId = null;
    s.need = null;
    s.moveTarget = null;
    s.away = true;
    s.activity = 'away';
    s.path = [];
    s.x = GATE_INSIDE.x + 2.5;
    s.y = GATE_INSIDE.y + 0.5;
  }
  // Abandon any treatment jobs for people leaving.
  state.jobs = state.jobs.filter((j) => !(j.kind === 'treat' && members.includes(j.targetId) && j.phase === 'queued' && !j.assigneeId));
  exp.log.push(`Set out for ${LOCATIONS[destination].name}.`);
  state.expeditions.push(exp);
  log(state, `${members.map((m) => first(getSurvivor(state, m)!)).join(', ')} set out for ${LOCATIONS[destination].name}.`, 'info');
  return { ok: true, message: 'Expedition under way.' };
}

function cargoRoom(state: GameState, exp: Expedition, id: ItemId): number {
  const n = exp.members.length;
  const mult = exp.vehicle ? 1.6 : 1;
  if (!ITEMS[id].solid) return Math.max(0, Math.round(n * WATER_PER_MEMBER * mult) - (exp.cargo.water ?? 0) - (exp.cargo.rawWater ?? 0));
  void state;
  return Math.max(0, Math.round(n * CARGO_PER_MEMBER * mult) - solidCount(exp.cargo));
}

/** Move found items into cargo, respecting capacity. Found items are new to the world (production). */
export function addFind(state: GameState, exp: Expedition, items: Items): Items {
  const got: Items = {};
  for (const id of LOOT_PRIORITY) {
    const want = Math.floor(items[id] ?? 0);
    if (want <= 0) continue;
    const v = Math.min(want, Math.floor(cargoRoom(state, exp, id)));
    if (v <= 0) continue;
    got[id] = v;
  }
  produce(state, got, exp.cargo);
  return got;
}

function search(state: GameState, exp: Expedition): void {
  const loc = state.locations[exp.destination];
  const q = searchQuality(state, exp.members, exp.packed);
  const want: Items = {};
  for (const id of Object.keys(loc.loot) as ItemId[]) {
    const have = loc.loot[id] ?? 0;
    const n = Math.max(have > 0 ? 1 : 0, Math.round(have * q));
    if (n > 0) want[id] = n;
  }
  const got = addFind(state, exp, want);
  for (const id of Object.keys(got) as ItemId[]) {
    loc.loot[id] = Math.max(0, (loc.loot[id] ?? 0) - (got[id] ?? 0));
    if (!loc.loot[id]) delete loc.loot[id];
  }
  // The station's hand pump never runs dry: fill any spare containers with untreated water.
  if (exp.destination === 'pumpStation') Object.assign(got, addFind(state, exp, { rawWater: 60 }));
  loc.visits++;
  exp.log.push(isEmpty(got) ? 'The place has been picked clean.' : `Recovered ${describeItems(got)}.`);
  // Risk: each member may be hurt while searching.
  const base = LOCATIONS[exp.destination].risk;
  for (const id of exp.members) {
    const s = getSurvivor(state, id)!;
    let p = base;
    if (s.trait === 'lightFooted') p *= 0.5;
    if (s.trait === 'tough') p *= 0.5;
    if ((exp.packed.meds ?? 0) > 0) p *= 0.6;
    if (chance(state, p)) {
      const hurt = randInt(state, 20, 35);
      s.injury = Math.min(100, s.injury + hurt);
      s.health = Math.max(5, s.health - hurt / 2);
      exp.log.push(`${first(s)} was hurt (${hurt >= 30 ? 'badly' : 'lightly'}).`);
      if ((exp.packed.meds ?? 0) >= 1) {
        consume(state, { meds: 1 }, exp.packed);
        s.injury = Math.max(0, s.injury - 20);
        exp.log.push(`Patched up ${first(s)} on the spot with packed meds.`);
      }
    }
  }
}

export function tickExpeditions(state: GameState): void {
  for (const exp of state.expeditions) {
    if (exp.phase === 'done') continue;
    const team = exp.members.map((id) => getSurvivor(state, id)!);
    for (const s of team) {
      if (!s.alive) continue;
      s.activity = 'away';
      updateNeeds(state, s, exp.packed);
    }
    if (team.every((s) => !s.alive)) {
      exp.phase = 'done';
      log(state, `The expedition to ${LOCATIONS[exp.destination].name} never came back.`, 'bad');
      // Packed supplies and cargo are lost with them.
      transferLost(state, exp);
      continue;
    }
    if (exp.phase === 'decision') continue; // waiting on the player
    if (stormActive(state)) {
      // Hunker down; time passes but no progress.
      if (!exp.log.includes('Sheltering from the storm.')) exp.log.push('Sheltering from the storm.');
      continue;
    }
    exp.elapsed++;
    if (exp.phase === 'outbound' && exp.elapsed >= exp.legMinutes) {
      exp.phase = 'searching';
      exp.elapsed = 0;
      exp.log.push(`Arrived at ${LOCATIONS[exp.destination].name}.`);
    } else if (exp.phase === 'searching' && exp.elapsed >= exp.searchMinutes + exp.bonusSearch) {
      if (!exp.pendingDecision) {
        search(state, exp);
        const loc = state.locations[exp.destination];
        if (!loc.decisionDone) {
          exp.phase = 'decision';
          exp.pendingDecision = exp.destination;
          state.flags.pendingExpedition = exp.id;
          continue;
        }
      }
      exp.phase = 'returning';
      exp.elapsed = 0;
      exp.log.push('Heading home.');
    } else if (exp.phase === 'returning' && exp.elapsed >= exp.legMinutes) {
      returnHome(state, exp);
    }
  }
  state.expeditions = state.expeditions.filter((e) => e.phase !== 'done' || state.minute - e.startedAt < 24 * 60);
}

function transferLost(state: GameState, exp: Expedition): void {
  consume(state, { ...exp.packed }, exp.packed);
  consume(state, { ...exp.cargo }, exp.cargo);
}

export function returnHome(state: GameState, exp: Expedition): void {
  exp.phase = 'done';
  const names: string[] = [];
  for (const id of exp.members) {
    const s = getSurvivor(state, id)!;
    if (!s.alive) continue;
    s.away = false;
    s.activity = 'idle';
    s.x = GATE_INSIDE.x + 0.5;
    s.y = GATE_INSIDE.y + 0.5 + names.length * 0.6;
    s.path = [];
    s.goal = null;
    names.push(first(s));
  }
  const fl = state.objects.find((o) => o.type === 'forklift' && o.data.away);
  if (fl && exp.vehicle) fl.data.away = 0;
  const haul: Items = {};
  transferAll(exp.cargo, haul);
  transferAll(exp.packed, haul);
  const summary = describeItems(haul);
  deposit(state, haul);
  if (!isEmpty(haul)) spillToCrate(state, haul);
  exp.log.push(`Home safe with ${summary}.`);
  log(state, `${names.join(', ')} returned from ${LOCATIONS[exp.destination].name} with ${summary}.`, 'good');
}

// ---------------------------------------------------------------- location decisions

export interface LocationChoice {
  id: string;
  label: string;
  detail: string;
}

export function locationDecision(_state: GameState, exp: Expedition): { title: string; body: string; choices: LocationChoice[] } {
  const hasTools = (exp.packed.tools ?? 0) > 0;
  switch (exp.destination) {
    case 'garage':
      return {
        title: 'The sedan on the lift',
        body: 'In the back bay a sedan hangs on a hydraulic lift, its fuel gauge reading three-quarters. The lift’s rams are weeping fluid and creak whenever anyone walks underneath.',
        choices: [
          { id: 'drain', label: 'Drain the tank', detail: '+6 fuel. Quick and safe.' },
          {
            id: 'strip',
            label: 'Drain it and strip the engine bay',
            detail: `+6 fuel, +2 mech, +1 elec. Two more hours under a failing lift — ${hasTools ? 'tools make it safer' : 'risky without tools'}.`,
          },
          { id: 'leave', label: 'Leave it', detail: 'Head home now.' },
        ],
      };
    case 'market':
      return {
        title: 'The barricaded stockroom',
        body: 'The stockroom door is barricaded from the inside with pallets. Through the gap: tinned food, a first-aid cabinet — and a child’s drawing taped to the shelf. Someone has been using this place.',
        choices: [
          { id: 'force', label: 'Force the door and take it', detail: '+8 food, +2 meds. Someone will notice.' },
          { id: 'note', label: 'Leave a note offering to trade', detail: 'Take nothing. Whoever this belongs to may remember it.' },
          { id: 'roof', label: 'Search the roof instead', detail: '+6 water, +1 tools. Safe, honest work.' },
        ],
      };
    case 'pumpStation':
    default:
      return {
        title: 'The pump house',
        body: 'The station’s hand pump still draws, and the filter housings hold sealed industrial cartridges. There is time to do one thing properly before the light goes.',
        choices: [
          { id: 'fill', label: 'Fill every container with water', detail: 'Fill cargo with treated station water (up to 20 L).' },
          { id: 'strip', label: 'Strip the filter housings', detail: '+2 filter cartridges, +1 mech. Cartridges double a sand filter’s output.' },
          { id: 'leave', label: 'Head home', detail: 'Get back before dark.' },
        ],
      };
  }
}

export function resolveLocationDecision(state: GameState, exp: Expedition, choiceId: string): string {
  const loc = state.locations[exp.destination];
  loc.decisionDone = true;
  exp.pendingDecision = null;
  let text = '';
  const hasTools = (exp.packed.tools ?? 0) > 0;
  const hurtOne = (p: number) => {
    const alive = exp.members.map((id) => getSurvivor(state, id)!).filter((s) => s.alive);
    if (!alive.length || !chance(state, p)) return '';
    const s = alive[randInt(state, 0, alive.length - 1)];
    s.injury = Math.min(100, s.injury + 35);
    s.health = Math.max(5, s.health - 18);
    return ` ${first(s)} was hurt when the lift slipped.`;
  };
  switch (`${exp.destination}:${choiceId}`) {
    case 'garage:drain':
      text = `Drained ${describeItems(addFind(state, exp, { fuel: 6 }))}.`;
      exp.bonusSearch = 45;
      break;
    case 'garage:strip':
      text = `Stripped the sedan: ${describeItems(addFind(state, exp, { fuel: 6, mech: 2, elec: 1 }))}.` + hurtOne(hasTools ? 0.15 : 0.45);
      exp.bonusSearch = 120;
      break;
    case 'market:force':
      text = `Took ${describeItems(addFind(state, exp, { food: 8, meds: 2 }))} from the stockroom.`;
      state.flags.raidedCache = true;
      state.trust.kessler -= 20;
      break;
    case 'market:note':
      text = 'Left a note and the stockroom untouched.';
      state.flags.leftNote = true;
      state.trust.kessler += 15;
      break;
    case 'market:roof':
      text = `Found ${describeItems(addFind(state, exp, { water: 6, tools: 1 }))} on the roof.`;
      break;
    case 'pumpStation:fill':
      text = `Filled containers: ${describeItems(addFind(state, exp, { water: 20 }))}.`;
      break;
    case 'pumpStation:strip':
      text = `Stripped the housings: ${describeItems(addFind(state, exp, { filter: 2, mech: 1 }))}.`;
      exp.bonusSearch = 60;
      break;
    default:
      text = 'Moved on.';
  }
  state.stats.choices.push(`${LOCATIONS[exp.destination].name}: ${text.split('.')[0]}`);
  exp.log.push(text);
  exp.phase = 'returning';
  exp.elapsed = -(exp.bonusSearch ?? 0);
  if (state.flags.pendingExpedition === exp.id) delete state.flags.pendingExpedition;
  return text;
}
