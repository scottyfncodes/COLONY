import { rawCapacity } from './inventory';
import { hashNoise } from './rng';
import { seedBonds } from './social';
import { START_MINUTE, MINUTES_PER_DAY } from './time';
import type { GameState, Items, ObjectType, Role, Skill, Survivor, TraitId, WorldConditions, WorldObject } from './types';

export const SAVE_VERSION = 4;

export const TRAITS: Record<TraitId, { name: string; text: string }> = {
  tinkerer: { name: 'Tinkerer', text: 'Recovers an extra part when dismantling machinery.' },
  nightOwl: { name: 'Night owl', text: 'Works late without penalty; sleeps 01:00–08:00.' },
  empath: { name: 'Empath', text: 'Lifts the whole group’s morale while at the compound.' },
  tough: { name: 'Tough', text: 'Shrugs off injuries and loses health more slowly.' },
  lightFooted: { name: 'Light-footed', text: 'Expeditions travel 25% faster with half the injury risk.' },
  bigAppetite: { name: 'Big appetite', text: 'Gets hungry 30% faster, but tires 25% slower.' },
  steady: { name: 'Steady hands', text: 'Repairs and services 20% faster.' },
};

export const ROLE_SKILL: Record<Role, Skill | null> = {
  Mechanic: 'mechanical',
  Electrician: 'electrical',
  Medic: 'medical',
  Builder: 'construction',
  Scavenger: 'scavenging',
  Generalist: null,
};

export interface SurvivorSeed {
  id: string;
  name: string;
  role: Role;
  trait: TraitId;
  secondary: Skill;
  look: Survivor['look'];
  x: number;
  y: number;
}

const ROSTER: SurvivorSeed[] = [
  { id: 's-ines', name: 'Ines Marrow', role: 'Mechanic', trait: 'tinkerer', secondary: 'construction', look: { skin: '#c99a76', hair: '#2b211c', hairStyle: 1, shirt: '#b5652e' }, x: 9, y: 9 },
  { id: 's-theo', name: 'Theo Vance', role: 'Electrician', trait: 'nightOwl', secondary: 'mechanical', look: { skin: '#e3bf9e', hair: '#c9a253', hairStyle: 0, shirt: '#3f78a8' }, x: 10, y: 9 },
  { id: 's-amara', name: 'Amara Okafor', role: 'Medic', trait: 'empath', secondary: 'scavenging', look: { skin: '#7a4f36', hair: '#120d0b', hairStyle: 2, shirt: '#e9e3d6' }, x: 9, y: 10 },
  { id: 's-rusk', name: 'Rusk Halloway', role: 'Builder', trait: 'tough', secondary: 'mechanical', look: { skin: '#b07a58', hair: '#5a3a22', hairStyle: 3, shirt: '#6d7a3a' }, x: 10, y: 10 },
  { id: 's-june', name: 'June Pell', role: 'Scavenger', trait: 'lightFooted', secondary: 'construction', look: { skin: '#d8a888', hair: '#8f2f1f', hairStyle: 2, shirt: '#7b4b8a' }, x: 11, y: 9 },
  { id: 's-sol', name: 'Sol Brenner', role: 'Generalist', trait: 'bigAppetite', secondary: 'construction', look: { skin: '#9b6b4b', hair: '#3a3a3a', hairStyle: 0, shirt: '#8a8f96' }, x: 11, y: 10 },
];

export const JOINER: SurvivorSeed = {
  id: 's-pavel',
  name: 'Pavel Kessler',
  role: 'Mechanic',
  trait: 'steady',
  secondary: 'electrical',
  look: { skin: '#d6b090', hair: '#6b6b6b', hairStyle: 3, shirt: '#4a5a6a' },
  x: 27,
  y: 15,
};

export function makeSurvivor(seed: SurvivorSeed, day = 1): Survivor {
  const skills: Record<Skill, number> = { mechanical: 0, electrical: 0, medical: 0, construction: 0, scavenging: 0 };
  const main = ROLE_SKILL[seed.role];
  if (main) {
    skills[main] = 3;
    skills[seed.secondary] = 1;
  } else {
    for (const k of Object.keys(skills) as Skill[]) skills[k] = 1;
    skills[seed.secondary] = 2;
  }
  return {
    id: seed.id,
    name: seed.name,
    role: seed.role,
    trait: seed.trait,
    skills,
    look: seed.look,
    x: seed.x + 0.5,
    y: seed.y + 0.5,
    path: [],
    goal: null,
    facing: 1,
    health: seed.role === 'Scavenger' ? 82 : 90,
    hunger: 70,
    thirst: 65,
    energy: 80,
    morale: 55,
    sick: 0,
    injury: seed.role === 'Scavenger' ? 15 : 0,
    alive: true,
    causeOfDeath: null,
    activity: 'idle',
    jobId: null,
    need: null,
    moveTarget: null,
    autoWork: true,
    away: false,
    relationships: {},
    workedMinutes: 0,
    joinedDay: day,
    sleptInBed: true,
    lastAte: 0,
    dose: 0,
    illness: null,
    trapped: false,
    quarantined: false,
  };
}

/** Strangers who may ask to join during a campaign (event director). */
export const DRIFTERS: SurvivorSeed[] = [
  { id: 's-mara', name: 'Mara Quist', role: 'Builder', trait: 'tough', secondary: 'scavenging', look: { skin: '#c4936c', hair: '#7a4a2a', hairStyle: 1, shirt: '#8a5a3a' }, x: 27, y: 15 },
  { id: 's-dev', name: 'Dev Okon', role: 'Scavenger', trait: 'lightFooted', secondary: 'mechanical', look: { skin: '#5e3c28', hair: '#151010', hairStyle: 3, shirt: '#3a6a5a' }, x: 27, y: 16 },
  { id: 's-lena', name: 'Lena Ruiz', role: 'Medic', trait: 'steady', secondary: 'construction', look: { skin: '#d2a07e', hair: '#2a1a12', hairStyle: 2, shirt: '#b8c4c8' }, x: 27, y: 15 },
];

export const NEVER = 9_000_000; // a minute that never arrives (disabled storm)

export function defaultWorld(weather: GameState['weather']): WorldConditions {
  return {
    catastrophe: 'storm',
    extra: [],
    difficulty: 'normal',
    mode: 'survival',
    random: false,
    radiation: 0,
    horde: 0,
    noise: 0,
    threat: 0,
    flood: 0,
    routes: {},
    hazards: {},
    climax: { kind: 'storm', label: 'The storm', at: weather.stormStart, end: weather.stormEnd, known: false, resolved: false },
    director: { intensity: 1, lastAdverse: 0, lastAny: 0, counts: {}, last: {}, pending: [] },
  };
}

let idc = 0;
export function obj(type: ObjectType, x: number, y: number, w: number, h: number, st: string, extra: Partial<WorldObject> = {}): WorldObject {
  idc++;
  return {
    id: extra.id ?? `o-${type}-${idc}`,
    type,
    x,
    y,
    w,
    h,
    state: st,
    condition: 100,
    reinforced: false,
    on: false,
    powered: false,
    data: {},
    contents: {},
    issues: [],
    ...extra,
  };
}

function initialObjects(): WorldObject[] {
  idc = 0;
  const pile = (x: number, y: number, w: number, contents: Items) => obj('scrapPile', x, y, w, 1, 'pile', { contents });
  return [
    obj('depot', 6, 6, 2, 2, 'operational', { id: 'depot' }),
    obj('table', 9, 6, 1, 1, 'operational', { id: 'table' }),
    obj('shelf', 10, 5, 1, 1, 'operational'),
    obj('shelf', 11, 5, 1, 1, 'operational'),
    obj('shelf', 5, 10, 1, 1, 'operational'),
    obj('radio', 5, 5, 1, 1, 'broken', { id: 'radio', issues: ['Blown output stage'] }),
    obj('workbench', 16, 5, 2, 1, 'damaged', { id: 'workbench', issues: ['Vice seized, grinder unwired'] }),
    obj('forklift', 19, 6, 1, 2, 'broken', { id: 'forklift', issues: ['Corroded hydraulics', 'Flat traction cell'] }),
    obj('generator', 24, 5, 2, 2, 'broken', {
      id: 'generator',
      condition: 35,
      issues: ['Seized engine block', 'Burnt starter wiring'],
    }),
    obj('drums', 26, 5, 1, 1, 'pile', { contents: { fuel: 3 } }),
    obj('batteryBank', 24, 8, 2, 1, 'damaged', { id: 'battery', issues: ['Two dead cells short the bank'] }),
    obj('waterPump', 24, 13, 1, 1, 'broken', { id: 'pump', issues: ['Cracked impeller', 'Seized bearing'] }),
    obj('waterTank', 25, 17, 2, 2, 'damaged', { id: 'tank', issues: ['Split seam — leaks above 40 L'] }),
    obj('pipes', 22, 19, 2, 1, 'intact', { id: 'pipes' }),
    pile(13, 14, 1, { scrap: 5, mech: 1 }),
    pile(18, 17, 1, { scrap: 4, elec: 1 }),
    pile(6, 24, 2, { scrap: 6, mech: 1, battery: 1 }),
    pile(25, 24, 1, { scrap: 4, mech: 1, elec: 1 }),
    pile(10, 26, 1, { scrap: 3, meds: 1 }),
    obj('wreckedCar', 21, 25, 2, 1, 'wreck', { id: 'car' }),
    obj('planter', 14, 23, 2, 1, 'overgrown', { id: 'planter-a', data: { growth: 0, moisture: 0 } }),
    obj('planter', 14, 25, 2, 1, 'overgrown', { id: 'planter-b', data: { growth: 0, moisture: 0 } }),
    obj('cot', 5, 15, 1, 1, 'operational', { id: 'cot-1' }),
    obj('cot', 5, 17, 1, 1, 'operational', { id: 'cot-2' }),
    obj('cot', 5, 19, 1, 1, 'operational', { id: 'cot-3' }),
    obj('gate', 29, 15, 1, 2, 'damaged', { id: 'gate', issues: ['Hinges sheared, chain cut'] }),
    obj('lamp', 20, 12, 1, 1, 'broken', { id: 'lamp-yard', issues: ['Corroded wiring'] }),
  ];
}

export function createGame(seed = 1): GameState {
  const state: GameState = {
    version: SAVE_VERSION,
    seed,
    rngState: seed >>> 0 || 1,
    minute: START_MINUTE,
    nextId: 1,
    survivors: ROSTER.map((r) => makeSurvivor(r)),
    objects: initialObjects(),
    jobs: [],
    inventory: { scrap: 6, mech: 1, elec: 1, fuel: 5, tools: 1, food: 14, water: 24, rawWater: 0, meds: 2 },
    ledger: { produced: {}, consumed: {} },
    power: { supply: 0, demand: 0, stored: 0, capacity: 0, deficit: false, fuelBurn: 0 },
    water: { rawCap: 0, cleanCap: 80, rawIn: 0, cleanIn: 0 },
    weather: makeWeather(seed),
    locations: {
      garage: { id: 'garage', visits: 0, loot: { fuel: 10, mech: 4, tools: 1, battery: 2, scrap: 8 }, decisionDone: false, discovered: [] },
      market: { id: 'market', visits: 0, loot: { food: 18, water: 16, meds: 3, scrap: 4 }, decisionDone: false, discovered: [] },
      pumpStation: { id: 'pumpStation', visits: 0, loot: { elec: 4, mech: 2, filter: 2, scrap: 6, fuel: 3 }, decisionDone: false, discovered: [] },
    },
    expeditions: [],
    events: { fired: {}, pending: null },
    log: [],
    flags: {},
    trust: { kessler: 0 },
    stats: { deaths: [], choices: [], powerHours: 0, cleanWaterMade: 0, foodGrown: 0, built: 0, repaired: 0, dismantled: 0, stormDamage: [] },
    objectivesDone: {},
    result: null,
    world: undefined as unknown as WorldConditions,
  };
  state.world = defaultWorld(state.weather);
  seedBonds(state);
  state.water.rawCap = rawCapacity(state);
  return state;
}

/** Weather is decided up front from the seed so the forecast is honest and replays are identical. */
export function makeWeather(seed: number): GameState['weather'] {
  const jitter = Math.floor(hashNoise(seed, 7) * 4) * 60; // 0–3 h
  const stormStart = 4 * MINUTES_PER_DAY + 17 * 60 + jitter; // Day 5, 17:00–20:00
  const stormEnd = stormStart + 16 * 60;
  const rainDay = 2 + Math.floor(hashNoise(seed, 11) * 2); // Day 3 or 4
  const rainStart = (rainDay - 1) * MINUTES_PER_DAY + (10 + Math.floor(hashNoise(seed, 13) * 6)) * 60;
  return {
    kind: 'clear',
    wind: 0.3,
    rain: 0,
    stormStart,
    stormEnd,
    stormForecastKnown: false,
    stormResolved: false,
    rainWindows: [{ start: rainStart, end: rainStart + 5 * 60 }],
  };
}
