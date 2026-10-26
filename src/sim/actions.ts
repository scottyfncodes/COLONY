import { count, log } from './inventory';
import type { CatastropheId, GameState, Items, JobKind, ObjectType, Skill, WorldObject } from './types';

export function activeCatastrophe(s: GameState, id: CatastropheId): boolean {
  return s.world.catastrophe === id || s.world.extra.includes(id);
}

// Data-driven catalogue of world objects, what can be done to them, and what can be built.
// Every action has explicit inputs, labour, skill, and an effect on persistent state.

export interface ObjectDef {
  name: string;
  blurb: string;
  /** kW drawn while running (consumers). */
  draw?: number;
  /** Shown as storm-exposed if outdoors and not reinforced. */
  stormVulnerable?: boolean;
}

export const OBJECT_DEFS: Record<ObjectType, ObjectDef> = {
  depot: { name: 'Supply cache', blurb: 'Where the group stores, eats and drinks. All hauling ends here.' },
  generator: {
    name: 'Diesel generator',
    blurb: 'A 6 kW diesel set. The heart of any working settlement — if it runs.',
    stormVulnerable: true,
  },
  forklift: { name: 'Forklift', blurb: 'An old warehouse forklift with a sound little engine under the seat.' },
  batteryBank: {
    name: 'Battery bank',
    blurb: 'A rack of deep-cycle cells. Stores surplus power for the night.',
    stormVulnerable: true,
  },
  waterPump: {
    name: 'Well pump',
    blurb: 'An electric pump over the old well. Lifts untreated groundwater — or use the bucket.',
    draw: 1.5,
    stormVulnerable: true,
  },
  waterTank: { name: 'Storage tank', blurb: 'A 300 L poly tank for untreated water.', stormVulnerable: true },
  pipes: { name: 'Pipe stack', blurb: 'Lengths of galvanised pipe and a few valves.' },
  scrapPile: { name: 'Scrap heap', blurb: 'A heap of junk. Someone patient will find something useful.' },
  wreckedCar: { name: 'Wrecked hatchback', blurb: 'Rusted out, tyres flat. The tank might still hold fuel.' },
  workbench: {
    name: 'Workbench',
    blurb: 'Vice, grinder and bins. Turns scrap into parts. Runs faster with power.',
    draw: 1,
  },
  radio: { name: 'Shortwave radio', blurb: 'A dusty transceiver. Could pick up weather bulletins — or neighbours.', draw: 0.2 },
  gate: { name: 'Perimeter gate', blurb: 'The only way in or out. Its chain is cut and the hinges sag.', stormVulnerable: true },
  planter: { name: 'Planter bed', blurb: 'Raised soil bed. Plant seed stock, keep it watered, harvest food.', stormVulnerable: true },
  cot: { name: 'Cot', blurb: 'A folding bed. Sleeping on concrete is miserable.' },
  storageRack: { name: 'Storage rack', blurb: 'Heavy shelving. +40 general storage.' },
  rainCatcher: { name: 'Rain catcher', blurb: 'Tarp funnel into a drum. Collects untreated water when it rains.', stormVulnerable: true },
  sandFilter: { name: 'Sand filter', blurb: 'Gravel, sand and charcoal. Slowly turns untreated water into drinking water. No power.' },
  purifier: { name: 'Boiler purifier', blurb: 'Electric boiler and condenser. Fast, clean water — if powered.', draw: 2 },
  windTurbine: { name: 'Scrap wind turbine', blurb: 'Welded blades on a car alternator. Free power when the wind blows.', stormVulnerable: true },
  lamp: { name: 'Work lamp', blurb: 'A floodlight on a pole. Light keeps spirits up and night work safe.', draw: 0.3, stormVulnerable: true },
  crate: { name: 'Overflow crate', blurb: 'Goods that did not fit in storage. Build racks, then haul them in.' },
  shelf: { name: 'Steel shelving', blurb: 'Bent shelving. Good for scrap.' },
  drums: { name: 'Fuel drums', blurb: 'Two blue drums. One still sloshes.' },
  rubble: { name: 'Rubble', blurb: 'Broken concrete and twisted steel brought down by the quake.' },
  barricade: { name: 'Barricade', blurb: 'Welded car doors, pallets and spikes. Adds to the compound’s defence.' },
  levee: { name: 'Sandbag levee', blurb: 'Bags of soil stacked against the creek. Two or more keep floodwater off the low ground.' },
  infirmary: { name: 'Isolation bed', blurb: 'A cot behind plastic sheeting. Quarantined patients rest here without infecting anyone; with power it runs a heater and treatment goes better.', draw: 0.5 },
  table: { name: 'Mess table', blurb: 'Where the group eats. A camp stove on it can boil untreated water.' },
};

export interface ActionDef {
  id: string;
  kind: JobKind;
  label: string;
  /** States in which the action is offered. */
  states: string[];
  inputs: (s: GameState, o: WorldObject) => Items;
  minutes: number;
  skill: Skill | null;
  tools: boolean;
  /** Items produced on completion and hauled to storage. */
  outputs?: (s: GameState, o: WorldObject) => Items;
  /** One-line description of the result. */
  result: (s: GameState, o: WorldObject) => string;
  /** Optional extra warning about what is lost. */
  warning?: (s: GameState, o: WorldObject) => string | null;
  /** Returns a reason the action cannot be queued right now (beyond missing materials), or null. */
  blocked?: (s: GameState, o: WorldObject) => string | null;
  effect: (s: GameState, o: WorldObject) => void;
  /** Hidden from the panel unless this returns true. */
  visible?: (s: GameState, o: WorldObject) => boolean;
}

const none = () => ({});
const fixed = (items: Items) => () => items;

function become(o: WorldObject, state: string): void {
  o.state = state;
  if (state === 'operational') o.issues = [];
}

const reinforce = (scrap: number, minutes = 90): ActionDef => ({
  id: 'reinforce',
  kind: 'reinforce',
  label: 'Reinforce',
  states: ['operational', 'broken', 'damaged', 'flooded', 'growing', 'empty', 'ready', 'intact', 'laid'],
  inputs: fixed({ scrap }),
  minutes,
  skill: 'construction',
  tools: false,
  result: () => 'Braced and covered. Shrugs off storm damage.',
  visible: (_s, o) => !o.reinforced,
  effect: (s, o) => {
    o.reinforced = true;
    log(s, `${OBJECT_DEFS[o.type].name} reinforced against the weather.`, 'good');
  },
});

const dismantle = (
  yields: (s: GameState, o: WorldObject) => Items,
  minutes: number,
  skill: Skill | null,
  tools: boolean,
  warning?: ActionDef['warning'],
  states = ['operational', 'broken', 'damaged', 'flooded', 'intact'],
): ActionDef => ({
  id: 'dismantle',
  kind: 'dismantle',
  label: 'Dismantle',
  states,
  inputs: none,
  minutes,
  skill,
  tools,
  outputs: yields,
  result: () => 'Broken down for parts. Gone for good.',
  warning,
  effect: (s, o) => {
    become(o, 'dismantled');
    o.on = false;
    s.stats.dismantled++;
    log(s, `${OBJECT_DEFS[o.type].name} dismantled.`, 'info');
  },
});

function repaired(s: GameState, o: WorldObject, text: string): void {
  become(o, 'operational');
  o.on = true;
  s.stats.repaired++;
  log(s, text, 'good');
}

export const ACTIONS: Partial<Record<ObjectType, ActionDef[]>> = {
  generator: [
    {
      id: 'overhaul',
      kind: 'repair',
      label: 'Overhaul engine',
      states: ['broken'],
      inputs: fixed({ mech: 3, elec: 2 }),
      minutes: 240,
      skill: 'mechanical',
      tools: true,
      result: () => 'Generator runs again: 6 kW, burns fuel.',
      effect: (s, o) => {
        o.condition = 70;
        repaired(s, o, 'The generator coughs, catches, and settles into a steady thrum. Power is back.');
      },
    },
    {
      id: 'fitEngine',
      kind: 'repair',
      label: 'Fit salvaged engine',
      states: ['broken'],
      inputs: fixed({ engine: 1, elec: 1 }),
      minutes: 180,
      skill: 'mechanical',
      tools: true,
      result: () => 'Swap in the forklift engine: 6 kW, 25% less fuel, better condition.',
      visible: (s) => count(s, 'engine') > 0 || s.objects.some((x) => x.type === 'forklift' && x.state !== 'dismantled' && x.state !== 'stripped'),
      effect: (s, o) => {
        o.condition = 95;
        o.data.efficient = 1;
        repaired(s, o, 'The forklift engine bolts onto the generator frame. It runs smoother than the original ever did.');
      },
    },
    {
      id: 'service',
      kind: 'service',
      label: 'Service',
      states: ['operational'],
      inputs: fixed({ mech: 1 }),
      minutes: 60,
      skill: 'mechanical',
      tools: true,
      result: () => 'Restores 40 condition. Worn generators lose output and can fail.',
      visible: (_s, o) => o.condition < 85,
      effect: (s, o) => {
        o.condition = Math.min(100, o.condition + 40);
        log(s, 'Generator serviced: fresh gaskets, clean filters.', 'good');
      },
    },
    {
      id: 'dryOut',
      kind: 'repair',
      label: 'Dry out & rewire',
      states: ['flooded'],
      inputs: fixed({ elec: 1, mech: 1 }),
      minutes: 120,
      skill: 'electrical',
      tools: true,
      result: () => 'Drain the intake, replace shorted wiring. Back to 6 kW.',
      effect: (s, o) => repaired(s, o, 'The generator is dried out and running again.'),
    },
    reinforce(3),
    dismantle(
      fixed({ mech: 2, elec: 2, scrap: 6 }),
      120,
      'mechanical',
      true,
      () => 'This is the only generator in the compound.',
    ),
  ],
  forklift: [
    {
      id: 'repairForklift',
      kind: 'repair',
      label: 'Repair',
      states: ['broken'],
      inputs: fixed({ mech: 2, battery: 1 }),
      minutes: 180,
      skill: 'mechanical',
      tools: true,
      result: () => 'A working vehicle: expeditions carry 60% more cargo and travel faster.',
      effect: (s, o) => repaired(s, o, 'The forklift whines to life. Expeditions can take it along.'),
    },
    {
      id: 'pullEngine',
      kind: 'repurpose',
      label: 'Pull engine',
      states: ['broken', 'operational'],
      inputs: none,
      minutes: 120,
      skill: 'mechanical',
      tools: true,
      outputs: fixed({ engine: 1 }),
      result: () => 'Recovers a sound engine that can be fitted to the generator.',
      warning: () => 'The forklift will never run again.',
      effect: (s, o) => {
        o.state = 'stripped';
        o.on = false;
        o.issues = ['Engine removed'];
        log(s, 'The forklift engine is out. The chassis sits gutted.', 'info');
      },
    },
    dismantle(
      (_s, o) => (o.state === 'stripped' ? { scrap: 5, battery: 1 } : { scrap: 5, mech: 3, battery: 1 }),
      90,
      'mechanical',
      true,
      (_s, o) => (o.state === 'stripped' ? null : 'Destroys the engine too.'),
      ['broken', 'operational', 'stripped'],
    ),
  ],
  batteryBank: [
    {
      id: 'recell',
      kind: 'repair',
      label: 'Replace dead cells',
      states: ['damaged'],
      inputs: fixed({ battery: 2, elec: 1 }),
      minutes: 120,
      skill: 'electrical',
      tools: true,
      result: () => 'Stores 30 kWh of surplus power for nights and outages.',
      effect: (s, o) => repaired(s, o, 'Battery bank online. Surplus power will be stored.'),
    },
    reinforce(2),
    dismantle(
      (_s, o) => (o.state === 'operational' ? { battery: 4, elec: 1, scrap: 2 } : { battery: 3, elec: 1, scrap: 2 }),
      90,
      'electrical',
      true,
      () => 'No more power storage.',
    ),
  ],
  waterPump: [
    {
      id: 'repairPump',
      kind: 'repair',
      label: 'Rebuild pump',
      states: ['broken'],
      inputs: fixed({ mech: 2, scrap: 1 }),
      minutes: 150,
      skill: 'mechanical',
      tools: true,
      result: () => 'Lifts 30 L/h of untreated water while powered (1.5 kW).',
      effect: (s, o) => repaired(s, o, 'The well pump spits rust, then clear water. It needs power to run.'),
    },
    {
      id: 'bucket',
      kind: 'salvage',
      label: 'Draw water by hand',
      states: ['broken', 'operational', 'flooded'],
      inputs: none,
      minutes: 40,
      skill: null,
      tools: false,
      outputs: fixed({ rawWater: 10 }),
      result: () => 'Haul up 10 L of untreated water with a bucket and rope. No power needed.',
      warning: () => 'Untreated: boil or filter it before drinking.',
      effect: () => {},
    },
    {
      id: 'dryPump',
      kind: 'repair',
      label: 'Dry out motor',
      states: ['flooded'],
      inputs: fixed({ elec: 1 }),
      minutes: 90,
      skill: 'electrical',
      tools: true,
      result: () => 'Rewind the soaked motor. Pumping resumes.',
      effect: (s, o) => repaired(s, o, 'The well pump hums again.'),
    },
    reinforce(2),
    dismantle(fixed({ mech: 1, elec: 1, scrap: 2 }), 60, 'mechanical', true, () => 'No more well water.'),
  ],
  waterTank: [
    {
      id: 'patchTank',
      kind: 'repair',
      label: 'Patch leaks',
      states: ['damaged'],
      inputs: fixed({ scrap: 3 }),
      minutes: 120,
      skill: 'construction',
      tools: true,
      result: () => 'Holds 300 L of untreated water instead of 40.',
      effect: (s, o) => repaired(s, o, 'Storage tank sealed. It can hold a proper reserve now.'),
    },
    reinforce(3),
    dismantle(fixed({ scrap: 8 }), 90, 'construction', true, () => 'Untreated storage drops to 20 L.'),
  ],
  pipes: [
    {
      id: 'irrigation',
      kind: 'repurpose',
      label: 'Lay irrigation',
      states: ['intact'],
      inputs: fixed({ mech: 1 }),
      minutes: 150,
      skill: 'construction',
      tools: true,
      result: () => 'Planters draw untreated water automatically. No more watering runs.',
      effect: (s, o) => {
        o.state = 'laid';
        log(s, 'Irrigation laid from the tank to the growing plot.', 'good');
      },
    },
    dismantle(fixed({ scrap: 5, mech: 1 }), 60, null, false, () => 'Pipes are needed for irrigation.', ['intact']),
  ],
  scrapPile: [
    {
      id: 'salvage',
      kind: 'salvage',
      label: 'Salvage',
      states: ['pile'],
      inputs: none,
      minutes: 75,
      skill: 'scavenging',
      tools: false,
      outputs: (_s, o) => ({ ...o.contents }),
      result: () => 'Sort the heap and haul anything useful to storage.',
      effect: (s, o) => {
        o.state = 'dismantled';
        log(s, 'Scrap heap picked clean.', 'info');
      },
    },
  ],
  wreckedCar: [
    {
      id: 'siphon',
      kind: 'salvage',
      label: 'Siphon fuel',
      states: ['wreck'],
      inputs: none,
      minutes: 30,
      skill: null,
      tools: false,
      outputs: fixed({ fuel: 4 }),
      result: () => 'Recovers 4 L of fuel.',
      effect: (s, o) => {
        o.state = 'siphoned';
        log(s, 'Four litres of stale petrol siphoned from the hatchback.', 'good');
      },
    },
    dismantle(
      fixed({ scrap: 6, battery: 1, elec: 1, mech: 1 }),
      150,
      'mechanical',
      true,
      (_s, o) => (o.state === 'wreck' ? 'The fuel in the tank will spill and be lost.' : null),
      ['wreck', 'siphoned'],
    ),
  ],
  workbench: [
    {
      id: 'repairBench',
      kind: 'repair',
      label: 'Fix workbench',
      states: ['damaged'],
      inputs: fixed({ scrap: 2, mech: 1 }),
      minutes: 90,
      skill: 'construction',
      tools: false,
      result: () => 'Unlocks crafting: parts and tool kits from scrap.',
      effect: (s, o) => repaired(s, o, 'Workbench restored. Scrap can now be turned into parts.'),
    },
    {
      id: 'craftMech',
      kind: 'craft',
      label: 'Machine parts',
      states: ['operational'],
      inputs: fixed({ scrap: 4 }),
      minutes: 90,
      skill: 'mechanical',
      tools: true,
      outputs: fixed({ mech: 1 }),
      result: () => '4 scrap → 1 mechanical part.',
      effect: () => {},
    },
    {
      id: 'craftElec',
      kind: 'craft',
      label: 'Rewire cells',
      states: ['operational'],
      inputs: fixed({ scrap: 2, battery: 1 }),
      minutes: 90,
      skill: 'electrical',
      tools: true,
      outputs: fixed({ elec: 2 }),
      result: () => '1 cell + 2 scrap → 2 electrical parts.',
      effect: () => {},
    },
    {
      id: 'craftTools',
      kind: 'craft',
      label: 'Tool kit',
      states: ['operational'],
      inputs: fixed({ scrap: 3, mech: 1 }),
      minutes: 120,
      skill: 'mechanical',
      tools: false,
      outputs: fixed({ tools: 1 }),
      result: () => 'A second set of tools lets two people do skilled work at once.',
      effect: () => {},
    },
    dismantle(fixed({ scrap: 4, mech: 1 }), 60, null, false, () => 'No more crafting.', ['damaged', 'operational']),
  ],
  radio: [
    {
      id: 'repairRadio',
      kind: 'repair',
      label: 'Repair radio',
      states: ['broken'],
      inputs: fixed({ elec: 1 }),
      minutes: 90,
      skill: 'electrical',
      tools: true,
      result: () => 'Weather bulletins and contact with other survivors (0.2 kW).',
      effect: (s, o) => repaired(s, o, 'Static, then a voice: a weather bulletin from somewhere north.'),
    },
    dismantle(fixed({ elec: 2, scrap: 1 }), 45, 'electrical', true, () => 'No more news from outside.', ['broken', 'operational']),
  ],
  gate: [
    {
      id: 'repairGate',
      kind: 'repair',
      label: 'Rehang & chain gate',
      states: ['damaged'],
      inputs: fixed({ scrap: 4, mech: 1 }),
      minutes: 150,
      skill: 'construction',
      tools: true,
      result: () => 'The compound can be secured at night.',
      effect: (s, o) => repaired(s, o, 'The gate swings true and locks. The compound feels safer.'),
    },
    reinforce(3),
  ],
  planter: [
    {
      id: 'clear',
      kind: 'clear',
      label: 'Clear bed',
      states: ['overgrown', 'damaged'],
      inputs: none,
      minutes: 60,
      skill: null,
      tools: false,
      result: () => 'Ready for planting.',
      effect: (s, o) => {
        o.state = 'empty';
        o.data.growth = 0;
        log(s, 'Planter bed cleared.', 'info');
      },
    },
    {
      id: 'plant',
      kind: 'plant',
      label: 'Plant seed stock',
      states: ['empty'],
      inputs: fixed({ food: 1 }),
      minutes: 45,
      skill: null,
      tools: false,
      result: () => 'Uses 1 ration as seed. Harvest ~5 rations in 36 h if kept watered.',
      effect: (s, o) => {
        o.state = 'growing';
        o.data.growth = 0;
        o.data.moisture = 70;
        log(s, 'Seed potatoes and beans in the ground.', 'good');
      },
    },
    {
      id: 'water',
      kind: 'water',
      label: 'Water',
      states: ['growing'],
      inputs: fixed({ rawWater: 4 }),
      minutes: 20,
      skill: null,
      tools: false,
      result: () => 'Soaks the bed with 4 L untreated water.',
      visible: (_s, o) => (o.data.moisture ?? 0) < 80,
      effect: (_s, o) => {
        o.data.moisture = 100;
      },
    },
    {
      id: 'harvest',
      kind: 'harvest',
      label: 'Harvest',
      states: ['ready'],
      inputs: none,
      minutes: 45,
      skill: null,
      tools: false,
      outputs: (_s, o) => ({ food: o.reinforced ? 6 : 5 }),
      result: () => 'Lift the crop and haul it to storage.',
      effect: (s, o) => {
        o.state = 'empty';
        o.data.growth = 0;
        s.stats.foodGrown += o.reinforced ? 6 : 5;
        log(s, 'Harvest in. Fresh food for the stores.', 'good');
      },
    },
    reinforce(2, 60),
    dismantle(fixed({ scrap: 2 }), 40, null, false, undefined, ['empty', 'overgrown', 'damaged']),
  ],
  cot: [dismantle(fixed({ scrap: 2 }), 30, null, false, () => 'One fewer bed.')],
  storageRack: [dismantle(fixed({ scrap: 3 }), 45, null, false, () => 'Storage capacity drops by 40.')],
  rainCatcher: [reinforce(2, 60), dismantle(fixed({ scrap: 2 }), 30, null, false)],
  sandFilter: [
    {
      id: 'cartridges',
      kind: 'repurpose',
      label: 'Fit filter cartridges',
      states: ['operational'],
      inputs: fixed({ filter: 1 }),
      minutes: 45,
      skill: null,
      tools: false,
      result: () => 'Doubles output to 10 L/h.',
      visible: (_s, o) => !o.data.cartridge,
      effect: (s, o) => {
        o.data.cartridge = 1;
        log(s, 'Industrial cartridges fitted. The sand filter runs twice as fast.', 'good');
      },
    },
    dismantle(fixed({ scrap: 3 }), 40, null, false),
  ],
  purifier: [dismantle(fixed({ scrap: 2, elec: 1 }), 60, 'electrical', true)],
  windTurbine: [
    {
      id: 'repairTurbine',
      kind: 'repair',
      label: 'Rebuild blades',
      states: ['broken'],
      inputs: fixed({ scrap: 2, mech: 1 }),
      minutes: 120,
      skill: 'mechanical',
      tools: true,
      result: () => 'Back to generating wind power.',
      effect: (s, o) => repaired(s, o, 'Turbine blades rebuilt and spinning.'),
    },
    reinforce(3),
    dismantle(fixed({ scrap: 4, elec: 1 }), 60, 'mechanical', true),
  ],
  lamp: [
    {
      id: 'repairLamp',
      kind: 'repair',
      label: 'Rewire lamp',
      states: ['broken'],
      inputs: fixed({ elec: 1 }),
      minutes: 45,
      skill: 'electrical',
      tools: false,
      result: () => 'Lights the yard at night (0.3 kW). Better morale, safer night work.',
      effect: (s, o) => repaired(s, o, 'The yard lamp flickers on.'),
    },
    dismantle(fixed({ elec: 1, scrap: 1 }), 30, null, false),
  ],
  crate: [
    {
      id: 'haulCrate',
      kind: 'salvage',
      label: 'Haul to storage',
      states: ['pile'],
      inputs: none,
      minutes: 15,
      skill: null,
      tools: false,
      outputs: (_s, o) => ({ ...o.contents }),
      result: () => 'Move the goods into storage (needs room).',
      effect: (_s, o) => {
        o.state = 'dismantled';
      },
    },
  ],
  table: [
    {
      id: 'boil',
      kind: 'craft',
      label: 'Boil water',
      states: ['operational'],
      inputs: fixed({ rawWater: 8, scrap: 1 }),
      minutes: 60,
      skill: null,
      tools: false,
      outputs: fixed({ water: 7 }),
      result: () => 'Burn scrap wood under a pot: 8 L untreated becomes 7 L safe to drink.',
      blocked: (s) => (activeCatastrophe(s, 'fallout') ? 'Boiling won’t remove fallout. Filter it.' : null),
      effect: (s) => {
        s.stats.cleanWaterMade += 7;
      },
    },
  ],
  shelf: [dismantle(fixed({ scrap: 2 }), 30, null, false)],
  rubble: [
    {
      id: 'digOut',
      kind: 'clear',
      label: 'Dig them out',
      states: ['pile'],
      inputs: none,
      minutes: 90,
      skill: 'construction',
      tools: false,
      outputs: fixed({ scrap: 2 }),
      result: (s, o) => {
        const who = s.survivors.find((x) => x.trapped && Math.floor(x.x) === o.x && Math.floor(x.y) === o.y);
        return who ? `${who.name} is pinned underneath. Every hour counts.` : 'Someone is pinned underneath.';
      },
      visible: (_s, o) => !!o.data.trapped,
      effect: (s, o) => {
        o.state = 'dismantled';
        const who = s.survivors.find((x) => x.trapped && Math.floor(x.x) === o.x && Math.floor(x.y) === o.y);
        if (who) {
          who.trapped = false;
          who.activity = 'idle';
          who.morale = Math.min(100, who.morale + 15);
          for (const x of s.survivors) if (x.alive && x !== who) x.morale = Math.min(100, x.morale + 8);
          log(s, `${who.name} is pulled from the rubble, bruised but alive.`, 'good');
        }
      },
    },
    {
      id: 'clearRubble',
      kind: 'clear',
      label: 'Clear rubble',
      states: ['pile'],
      inputs: none,
      minutes: 80,
      skill: 'construction',
      tools: false,
      outputs: (_s, o) => ({ scrap: 2 * o.w * o.h }),
      result: () => 'Break it up and haul the steel to storage. A working forklift makes this much faster.',
      visible: (_s, o) => !o.data.trapped,
      effect: (s, o) => {
        o.state = 'dismantled';
        log(s, 'Rubble cleared.', 'info');
      },
    },
  ],
  barricade: [reinforce(3, 60), dismantle(fixed({ scrap: 3 }), 40, null, false)],
  levee: [dismantle(fixed({ scrap: 1 }), 30, null, false)],
  infirmary: [dismantle(fixed({ scrap: 2 }), 30, null, false)],
  drums: [
    {
      id: 'drain',
      kind: 'salvage',
      label: 'Decant fuel',
      states: ['pile'],
      inputs: none,
      minutes: 25,
      skill: null,
      tools: false,
      outputs: (_s, o) => ({ ...o.contents }),
      result: () => 'Pour off whatever fuel is left into jerry cans.',
      effect: (s, o) => {
        o.state = 'dismantled';
        log(s, 'Fuel drums drained.', 'info');
      },
    },
  ],
};

/** Objects whose contents are removed when the action that empties them completes. */
export const EMPTIES_CONTENTS = new Set(['salvage', 'haulCrate', 'drain']);

export interface Blueprint {
  type: ObjectType;
  name: string;
  w: number;
  h: number;
  inputs: Items;
  minutes: number;
  initialState: string;
  blurb: string;
  needsTools: boolean;
  /** Catastrophes that make this blueprint available; omitted = always. */
  scenarios?: CatastropheId[];
  /** Placement rule beyond the usual checks; returns a reason or null. */
  zone?: (x: number, y: number) => string | null;
}

export const BLUEPRINTS: Blueprint[] = [
  { type: 'cot', name: 'Cot', w: 1, h: 1, inputs: { scrap: 3 }, minutes: 60, initialState: 'operational', blurb: 'A bed. Survivors without one sleep badly and lose morale.', needsTools: false },
  { type: 'planter', name: 'Planter bed', w: 2, h: 1, inputs: { scrap: 3 }, minutes: 90, initialState: 'empty', blurb: 'Grow food. Needs seed stock and water.', needsTools: false },
  { type: 'rainCatcher', name: 'Rain catcher', w: 1, h: 1, inputs: { scrap: 3, mech: 1 }, minutes: 90, initialState: 'operational', blurb: 'Collects untreated water when it rains — and a storm is coming.', needsTools: false },
  { type: 'sandFilter', name: 'Sand filter', w: 1, h: 1, inputs: { scrap: 4, mech: 1 }, minutes: 150, initialState: 'operational', blurb: 'Treats 5 L/h of untreated water. No power needed.', needsTools: true },
  { type: 'purifier', name: 'Boiler purifier', w: 1, h: 1, inputs: { scrap: 3, elec: 2, mech: 1 }, minutes: 210, initialState: 'operational', blurb: 'Treats 15 L/h. Draws 2 kW.', needsTools: true },
  { type: 'storageRack', name: 'Storage rack', w: 2, h: 1, inputs: { scrap: 4 }, minutes: 75, initialState: 'operational', blurb: '+40 general storage.', needsTools: false },
  { type: 'windTurbine', name: 'Wind turbine', w: 1, h: 1, inputs: { scrap: 6, mech: 2, elec: 2 }, minutes: 300, initialState: 'operational', blurb: 'Fuel-free power that varies with the wind. Strong storm winds will wreck it unless reinforced.', needsTools: true },
  { type: 'barricade', name: 'Barricade', w: 2, h: 1, inputs: { scrap: 4 }, minutes: 90, initialState: 'operational', blurb: 'Raises the compound’s defence against raiders and the infected. Most useful near the fence.', needsTools: false, scenarios: ['collapse', 'outbreak'] },
  { type: 'levee', name: 'Sandbag levee', w: 2, h: 1, inputs: { scrap: 1 }, minutes: 60, initialState: 'operational', blurb: 'Two or more on the low ground keep the flood off the growing plot and out of the well.', needsTools: false, scenarios: ['quake'], zone: (_x, y) => (y >= 20 ? null : 'Levees go on the low ground in the south of the compound.') },
  { type: 'infirmary', name: 'Isolation bed', w: 1, h: 1, inputs: { scrap: 3 }, minutes: 60, initialState: 'operational', blurb: 'Quarantined patients rest here without spreading illness. Powered (0.5 kW), treatment works better.', needsTools: false, scenarios: ['pandemic', 'outbreak'] },
  { type: 'lamp', name: 'Work lamp', w: 1, h: 1, inputs: { scrap: 2, elec: 1 }, minutes: 60, initialState: 'operational', blurb: 'Lights the area at night. Draws 0.3 kW.', needsTools: false },
];

export function blueprint(type: ObjectType): Blueprint | undefined {
  return BLUEPRINTS.find((b) => b.type === type);
}

/** Any burning object can be doused; this is offered on top of its normal actions. */
export const DOUSE: ActionDef = {
  id: 'douse',
  kind: 'repair',
  label: 'Put out the fire',
  states: ['operational', 'broken', 'damaged', 'flooded', 'growing', 'ready', 'empty', 'intact', 'laid', 'stripped', 'wreck', 'siphoned', 'overgrown', 'pile'],
  inputs: (s) => (count(s, 'rawWater') >= 10 ? { rawWater: 10 } : { water: 10 }),
  minutes: 25,
  skill: null,
  tools: false,
  result: () => 'Throw 10 L of water on it before it burns out. Untreated water is used first.',
  visible: (_s, o) => !!o.data.burning,
  effect: (s, o) => {
    o.data.burning = 0;
    log(s, `Fire on the ${OBJECT_DEFS[o.type].name.toLowerCase()} put out.`, 'good');
  },
};

export function actionsFor(o: WorldObject): ActionDef[] {
  const base = ACTIONS[o.type] ?? [];
  return o.data.burning ? [DOUSE, ...base] : base;
}

export function findAction(o: WorldObject, id: string): ActionDef | undefined {
  if (id === 'douse') return DOUSE;
  return actionsFor(o).find((a) => a.id === id);
}

export function objectName(o: WorldObject): string {
  if (o.type === 'pipes' && o.state === 'laid') return 'Irrigation manifold';
  if (o.type === 'forklift' && o.state === 'stripped') return 'Gutted forklift';
  return OBJECT_DEFS[o.type].name;
}
