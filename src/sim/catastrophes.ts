import { activeCatastrophe, objectName } from './actions';
import { consume, consumeUpTo, count, log } from './inventory';
import { describeItems } from './items';
import { getSurvivor } from './jobs';
import { chance, randInt } from './rng';
import { NEVER, obj } from './setup';
import { presentSurvivors } from './survivors';
import { dayOf, isNight, MINUTES_PER_DAY, SCENARIO_DAYS } from './time';
import { isSheltered } from './world';
import type { EventDef } from './events';
import type { CatastropheId, ClimaxKind, Difficulty, GameMode, GameState, ItemId, LocationId, Survivor, WorldObject } from './types';

// Data-driven catastrophes. Each one changes the starting world, feeds numeric
// modifiers into the core systems, ticks its own hazards, and contributes events.
// Core systems never branch on a catastrophe by name except through these hooks.

export interface Mods {
  /** Multiplier on loot found by expeditions. */
  loot: number;
  /** Multiplier on expedition injury risk. */
  risk: number;
  /** Multiplier on the chance that untreated water makes someone ill. */
  rawSick: number;
  /** Multiplier on hunger/thirst decay (difficulty). */
  needs: number;
  /** Flat morale offset. */
  morale: number;
  /** Multiplier on the director's adverse-event weight. */
  adverse: number;
  /** Multiplier on the director's opportunity weight. */
  opportunity: number;
}

const NEUTRAL: Mods = { loot: 1, risk: 1, rawSick: 1, needs: 1, morale: 0, adverse: 1, opportunity: 1 };

export interface CatastropheDef {
  id: CatastropheId;
  name: string;
  /** Kind of disaster, as the brief names it. */
  kind: string;
  tagline: string;
  /** What actually changes in play — shown on the selection screen. */
  pressures: string[];
  intro: string;
  accent: string;
  /** Outskirts haze colour and a multiply tint for the whole scene. */
  haze: string;
  tint: string;
  particles: 'none' | 'ash' | 'dust' | 'smoke';
  climax: { kind: ClimaxKind; label: string; objective: string; detail: string };
  mods: Partial<Mods>;
  /** Changes to a brand-new game. */
  setup: (s: GameState) => void;
  /** Lighter version for adding this catastrophe to a running sandbox game. */
  inject: (s: GameState) => void;
  objective?: { id: string; label: string; detail: string; done: (s: GameState) => boolean; progress: (s: GameState) => string };
  events: EventDef[];
}

export function isActive(s: GameState, id: CatastropheId): boolean {
  return activeCatastrophe(s, id);
}

export function activeDefs(s: GameState): CatastropheDef[] {
  const ids = [s.world.catastrophe, ...s.world.extra.filter((x) => x !== s.world.catastrophe)];
  return ids.map((id) => CATASTROPHES[id]).filter(Boolean);
}

const DIFFICULTY: Record<Difficulty, { supplies: number; needs: number; adverse: number; loot: number; label: string; blurb: string }> = {
  easy: { supplies: 1.4, needs: 0.85, adverse: 0.6, loot: 1.1, label: 'Forgiving', blurb: 'More supplies, slower hunger and thirst, fewer crises.' },
  normal: { supplies: 1, needs: 1, adverse: 1, loot: 1, label: 'Standard', blurb: 'The intended balance.' },
  hard: { supplies: 0.6, needs: 1.22, adverse: 1.6, loot: 0.8, label: 'Brutal', blurb: 'Half the supplies, thin scavenging, faster hunger and thirst, and crises come often. Expect losses.' },
};

export function difficultyInfo(d: Difficulty) {
  return DIFFICULTY[d];
}

export function mods(s: GameState): Mods {
  const m: Mods = { ...NEUTRAL };
  for (const d of activeDefs(s)) {
    for (const k of Object.keys(d.mods) as (keyof Mods)[]) {
      const v = d.mods[k]!;
      if (k === 'morale') m.morale += v;
      else m[k] *= v;
    }
  }
  const diff = DIFFICULTY[s.world.difficulty] ?? DIFFICULTY.normal;
  m.needs *= diff.needs;
  m.adverse *= diff.adverse;
  m.loot *= diff.loot;
  const strain = endlessStrain(s);
  if (strain) {
    m.needs *= 1 + 0.04 * strain;
    m.adverse *= 1 + 0.15 * strain;
    m.loot *= Math.max(0.4, 1 - 0.06 * strain);
  }
  return m;
}

/** Days past the first week in an endless run; pressure grows with each one. */
export function endlessStrain(s: GameState): number {
  return s.flags.endless ? Math.max(0, (s.minute - SCENARIO_DAYS * MINUTES_PER_DAY) / MINUTES_PER_DAY) : 0;
}

// ---------------------------------------------------------------- shared world helpers

export function defense(s: GameState): { value: number; parts: string[] } {
  const parts: string[] = [];
  let v = 0;
  const gate = s.objects.find((o) => o.type === 'gate');
  if (gate && gate.state === 'operational') {
    v += 3;
    parts.push('gate secured +3');
    if (gate.reinforced) {
      v += 1;
      parts.push('gate braced +1');
    }
  }
  const bars = s.objects.filter((o) => o.type === 'barricade' && o.state === 'operational');
  const bv = Math.min(4.5, bars.reduce((t, b) => t + (b.reinforced ? 2 : 1.5), 0));
  if (bv) {
    v += bv;
    parts.push(`${bars.length} barricade${bars.length > 1 ? 's' : ''} +${bv}`);
  }
  const lamps = s.objects.filter((o) => o.type === 'lamp' && o.state === 'operational' && o.powered).length;
  if (lamps && isNight(s.minute)) {
    v += Math.min(1, lamps * 0.5);
    parts.push(`lit yard +${Math.min(1, lamps * 0.5)}`);
  }
  const able = presentSurvivors(s).filter((x) => x.health > 50 && !x.illness && !x.trapped && !x.quarantined).length;
  const sv = Math.min(2, able * 0.3);
  if (sv) {
    v += sv;
    parts.push(`${able} able defenders +${sv.toFixed(1)}`);
  }
  return { value: Math.round(v * 10) / 10, parts };
}

/** Outdoor radiation right now (mSv/h): base level plus rain washing fallout down. */
export function radiationNow(s: GameState): number {
  if (!isActive(s, 'fallout') && s.world.radiation <= 0) return 0;
  return s.world.radiation * (1 + s.weather.rain * 1.5);
}

/** Exposure to something contagious (strangers, hot zones). May give one person an incubating fever. */
export function contact(s: GameState, p: number, who?: Survivor[]): Survivor | null {
  if (!isActive(s, 'pandemic')) return null;
  const pool = (who ?? presentSurvivors(s)).filter((x) => x.alive && !x.illness && !x.immune);
  if (!pool.length || !chance(s, p)) return null;
  const v = pool[randInt(s, 0, pool.length - 1)];
  v.illness = { kind: 'fever', stage: 'incubating', t: randInt(s, 14, 26) * 60 };
  return v;
}

export function infect(s: Survivor, kind: 'fever' | 'bite', hours: number): void {
  s.illness = { kind, stage: 'incubating', t: hours * 60 };
}

export interface LocationHazard {
  risk: number;
  radiation: number;
  infection: number;
  bite: number;
  notes: string[];
}

const LOC_RAD: Record<LocationId, number> = { garage: 1, market: 0.8, pumpStation: 1.8 };

export function locationHazard(s: GameState, loc: LocationId): LocationHazard {
  const m = mods(s);
  const h: LocationHazard = { risk: m.risk, radiation: 0, infection: 0, bite: 0, notes: [] };
  const extra = s.world.hazards[loc];
  if (extra && extra.until > s.minute) {
    h.risk *= extra.risk;
    h.notes.push(extra.note);
  }
  if (isActive(s, 'fallout') || s.world.radiation > 0) {
    h.radiation = radiationNow(s) * LOC_RAD[loc] * (extra?.note.includes('plume') ? 2 : 1);
    if (h.radiation > 0.5) h.notes.push(`~${h.radiation.toFixed(1)} mSv/h out there`);
  }
  if (isActive(s, 'pandemic')) {
    h.infection = loc === 'market' ? 0.3 : 0.12;
    if (extra?.note.includes('fever')) h.infection *= 2;
    h.notes.push(loc === 'market' ? 'Pharmacy, but crowded with the sick' : 'Some risk of catching the fever');
  }
  if (isActive(s, 'outbreak')) {
    h.bite = 0.45;
    h.notes.push('Infected in the area: injuries may be bites');
  }
  return h;
}

/** Spread a fire to an object; it burns out in 3 hours unless doused. */
export function ignite(s: GameState, o: WorldObject, why: string): void {
  if (o.data.burning) return;
  o.data.burning = 1;
  log(s, `${why} The ${objectName(o).toLowerCase()} is on fire! Douse it with 10 L of water within 3 hours.`, 'bad');
}

function freeOutdoorTile(s: GameState, w: number, h: number): { x: number; y: number } | null {
  // Lazy import to avoid a cycle: validatePlacement lives in sim.ts.
  for (let tries = 0; tries < 40; tries++) {
    const x = randInt(s, 4, 26);
    const y = randInt(s, 12, 26);
    if (isSheltered(x, y)) continue;
    if (placementOk && placementOk(s, w, h, x, y)) return { x, y };
  }
  return null;
}

let placementOk: ((s: GameState, w: number, h: number, x: number, y: number) => boolean) | null = null;
export function setPlacementCheck(fn: (s: GameState, w: number, h: number, x: number, y: number) => boolean): void {
  placementOk = fn;
}

export function addRubble(s: GameState, x: number, y: number, w = 1, h = 1, trapped = false): WorldObject {
  const o = obj('rubble', x, y, w, h, 'pile', { id: `o-rubble-${s.nextId++}`, data: trapped ? { trapped: 1 } : {}, issues: trapped ? ['Someone is pinned underneath'] : [] });
  s.objects.push(o);
  return o;
}

// ---------------------------------------------------------------- climaxes (raid / horde)

function climaxEvents(kind: 'raid' | 'horde'): EventDef[] {
  const warn: EventDef = {
    id: `${kind}Warning`,
    when: (s) => s.world.climax.kind === kind && !s.world.climax.known && s.minute >= s.world.climax.at - 20 * 60,
    fire: (s) => {
      s.world.climax.known = true;
      log(
        s,
        kind === 'raid'
          ? 'Word on the road: the Ridge Crew are coming for the compound tomorrow night. Secure the gate, build barricades, or find something to pay them with.'
          : 'The infected are thickening along the creek. By tomorrow night there will be a horde at the fence. Cut the noise and strengthen the defences.',
        'warn',
      );
      return null;
    },
  };
  const start: EventDef = {
    id: `${kind}Climax`,
    when: (s) => s.world.climax.kind === kind && !s.world.climax.resolved && s.minute >= s.world.climax.at,
    fire: (s) => {
      s.world.climax.known = true;
      const d = defense(s);
      const strength = climaxStrength(s);
      const odds = d.value >= strength ? 'The defences look strong enough.' : d.value >= strength * 0.7 ? 'It will be close.' : 'The defences are badly outmatched.';
      const gen = s.objects.find((o) => o.type === 'generator');
      const kessler = s.trust.kessler >= 25;
      const volunteer = presentSurvivors(s).filter((x) => x.energy > 40 && x.health > 50 && !x.illness).sort((a, b) => b.skills.scavenging - a.skills.scavenging)[0];
      if (kind === 'raid') {
        const food = Math.floor(count(s, 'food') * 0.5);
        const fuel = Math.floor(count(s, 'fuel') * 0.5);
        return {
          id: start.id,
          title: 'The Ridge Crew',
          body: `Headlights on the county road. A dozen of them, armed with pipes and a hunting rifle, spread out along the fence.\n\nDefence ${d.value} against a raid of strength ${strength.toFixed(0)}. ${odds}`,
          choices: [
            { id: 'hold', label: 'Hold the gate', detail: 'Fight them off. Losing means stolen supplies and injuries.', available: true },
            { id: 'pay', label: 'Pay them to leave', detail: `Hand over ${food} food and ${fuel} L fuel. They’ll be back, but not tonight.`, available: food + fuel > 0, reason: 'Nothing worth taking' },
            { id: 'kessler', label: 'Signal the Kesslers', detail: 'Marta’s people come at them from behind (+4 defence), then hold the gate.', available: kessler, reason: 'Needs the Kesslers’ trust' },
          ],
          context: { strength: String(strength), volunteer: '' },
        };
      }
      return {
        id: start.id,
        title: 'The horde',
        body: `They come out of the dark in their hundreds, drawn by every engine and light for miles. The fence groans.\n\nDefence ${d.value} against a horde of strength ${strength.toFixed(0)}. ${odds}`,
        choices: [
          { id: 'hold', label: 'Hold the fence', detail: 'Everyone fights. Losing means wrecked defences and bites.', available: true },
          { id: 'dark', label: 'Go dark and silent', detail: 'Kill the generator and every light. The horde loses interest (strength ×0.6), then hold the fence.', available: !!gen },
          {
            id: 'lure',
            label: volunteer ? `Send ${volunteer.name.split(' ')[0]} to draw them off` : 'Draw them off',
            detail: 'One runner leads them away with the car horn. No fight at the fence, but the runner may be hurt or bitten.',
            available: !!volunteer,
            reason: 'Nobody is fit enough to run',
          },
        ],
        context: { strength: String(strength), volunteer: volunteer?.id ?? '' },
      };
    },
    resolve: (s, id, ev) => resolveClimax(s, kind, id, Number(ev.context.strength), ev.context.volunteer),
  };
  return [warn, start];
}

export function climaxStrength(s: GameState): number {
  const base = s.world.climax.kind === 'raid' ? 4 + s.world.threat / 12 : 3 + s.world.horde / 9;
  const diff = s.world.difficulty === 'hard' ? 1.2 : s.world.difficulty === 'easy' ? 0.8 : 1;
  return Math.round(base * diff * 10) / 10;
}

function injure(s: GameState, x: Survivor, amount: number, biteChance: number): string {
  x.injury = Math.min(100, x.injury + amount);
  x.health = Math.max(5, x.health - amount / 2);
  if (biteChance > 0 && chance(s, biteChance)) {
    infect(x, 'bite', 18);
    return `${x.name.split(' ')[0]} was bitten`;
  }
  return `${x.name.split(' ')[0]} was hurt`;
}

function resolveClimax(s: GameState, kind: 'raid' | 'horde', choice: string, strength: number, volunteerId?: string): string {
  const out: string[] = [];
  const able = () => presentSurvivors(s).filter((x) => !x.trapped && !x.quarantined);
  s.world.climax.resolved = true;
  const bite = kind === 'horde' ? 0.35 : 0;
  const damageDefences = () => {
    const gate = s.objects.find((o) => o.type === 'gate');
    if (gate && gate.state === 'operational' && !gate.reinforced) {
      gate.state = 'damaged';
      gate.issues = ['Smashed open'];
      out.push('the gate was smashed open');
    }
    for (const b of s.objects.filter((o) => o.type === 'barricade' && o.state === 'operational' && !o.reinforced).slice(0, 2)) {
      b.state = 'dismantled';
      out.push('a barricade was torn down');
    }
  };
  if (choice === 'pay' && kind === 'raid') {
    const food = consumeUpTo(s, 'food', Math.floor(count(s, 'food') * 0.5));
    const fuel = consumeUpTo(s, 'fuel', Math.floor(count(s, 'fuel') * 0.5));
    s.world.threat = 30;
    for (const x of able()) x.morale = Math.max(0, x.morale - 8);
    s.stats.choices.push('Paid off the Ridge Crew');
    s.stats.stormDamage.push(`paid ${describeItems({ food, fuel })} in tribute`);
    return `They load ${describeItems({ food, fuel })} onto their truck and drive off laughing.`;
  }
  if (choice === 'lure' && kind === 'horde') {
    const v = getSurvivor(s, volunteerId ?? null);
    s.world.horde = Math.max(0, s.world.horde - 55);
    if (v && v.alive) {
      v.energy = Math.max(0, v.energy - 50);
      if (chance(s, 0.5)) out.push(injure(s, v, 30, 0.3));
      s.stats.choices.push(`${v.name} drew the horde away`);
    }
    if (out.length) s.stats.stormDamage.push(...out);
    return `The horn wails off into the dark and the horde follows it.${out.length ? ` ${out.join('; ')}.` : ' The runner makes it back at dawn.'}`;
  }
  let d = defense(s).value;
  let st = strength;
  if (choice === 'kessler') {
    d += 4;
    s.stats.choices.push('The Kesslers helped defend the compound');
  }
  if (choice === 'dark') {
    st *= 0.6;
    for (const o of s.objects) if ((o.type === 'generator' || o.type === 'lamp') && o.state === 'operational') o.on = false;
    s.world.noise = 0;
    s.stats.choices.push('Went dark to hide from the horde');
  }
  if (d >= st) {
    for (const x of able()) x.morale = Math.min(100, x.morale + 10);
    if (chance(s, 0.35)) {
      const team = able();
      if (team.length) out.push(injure(s, team[randInt(s, 0, team.length - 1)], 25, bite));
    }
    if (kind === 'raid') s.world.threat = 10;
    else s.world.horde = Math.max(0, s.world.horde - 60);
    s.stats.stormDamage.push(...out);
    return `They break against the defences and fall back.${out.length ? ` ${out.join('; ')}.` : ' Nobody is hurt.'}`;
  }
  damageDefences();
  const team = able();
  const hurt = Math.min(team.length, st - d > 3 ? 2 : 1);
  for (let i = 0; i < hurt; i++) out.push(injure(s, team[randInt(s, 0, team.length - 1)], 35, bite));
  if (kind === 'raid') {
    const taken: Partial<Record<ItemId, number>> = {};
    for (const k of ['food', 'fuel', 'meds'] as ItemId[]) taken[k] = consumeUpTo(s, k, Math.floor(count(s, k) * 0.4));
    out.push(`they took ${describeItems(taken)}`);
    s.world.threat = 25;
  } else {
    consumeUpTo(s, 'food', Math.floor(count(s, 'food') * 0.2));
    out.push('the stores were trampled');
    s.world.horde = Math.max(0, s.world.horde - 40);
  }
  for (const x of presentSurvivors(s)) x.morale = Math.max(0, x.morale - 12);
  s.stats.stormDamage.push(...out);
  return `The defences give way. ${out.join('; ')}.`;
}

// ---------------------------------------------------------------- definitions

const storm: CatastropheDef = {
  id: 'storm',
  name: 'Storm Season',
  kind: 'Original scenario',
  tagline: 'Six survivors, a dead compound, and a storm on the way.',
  pressures: ['A great storm hits on Day 5: brace exposed machinery', 'Strangers at the gate on Day 3', 'The balanced, original seven days'],
  intro:
    'Six of you made it to the old Brannock Tool & Die compound. The fence still stands. The generator is seized, the well pump is dead, and there is food for two days and water for one.\n\nAn old trucker on the road said a big storm comes off the plains every autumn. Make this place work, and keep everyone alive for seven days.',
  accent: '#e8a33d',
  haze: '#56493a',
  tint: 'rgba(0,0,0,0)',
  particles: 'none',
  climax: { kind: 'storm', label: 'The storm', objective: 'Weather the storm', detail: 'Come through the storm with the settlement intact.' },
  mods: {},
  setup: () => {},
  inject: (s) => scheduleSquall(s, 3 * 60),
  events: [],
};

const quake: CatastropheDef = {
  id: 'quake',
  name: 'Aftershock',
  kind: 'Natural disaster',
  tagline: 'The quake brought the roof down. The river is rising.',
  pressures: ['Sol is pinned under rubble: dig him out fast', 'Aftershocks damage unbraced machines; rubble blocks the yard', 'The storm floods the low ground unless you build levees', 'The road to the market is cut'],
  intro:
    'The ground stopped shaking an hour ago. Part of the warehouse came down, and Sol is pinned under the rubble by the east wall. Broken concrete is strewn across the yard.\n\nThe creek is already high, and the radio said a storm is coming in behind the quake. Dig Sol out, clear the yard, and get sandbags on the low ground before the water comes.',
  accent: '#d9934a',
  haze: '#665a48',
  tint: 'rgba(120,96,60,0.10)',
  particles: 'dust',
  climax: { kind: 'storm', label: 'The flood', objective: 'Survive the flood', detail: 'Come through the storm and flood with the settlement intact.' },
  mods: { risk: 1.25, loot: 0.9 },
  setup: (s) => {
    const sol = s.survivors.find((x) => x.id === 's-sol');
    if (sol) {
      sol.x = 11.5;
      sol.y = 10.5;
      sol.trapped = true;
      sol.injury = 45;
      sol.health = 62;
      sol.activity = 'trapped';
    }
    addRubble(s, 11, 10, 1, 1, true);
    addRubble(s, 8, 11, 1, 1); // the warehouse's south door
    addRubble(s, 16, 13, 2, 1);
    addRubble(s, 21, 21, 2, 2);
    addRubble(s, 10, 22, 1, 1);
    addRubble(s, 23, 10, 2, 1);
    const bench = s.objects.find((o) => o.type === 'workbench');
    if (bench) bench.issues.push('Shaken off its mounts');
    s.world.routes.market = { until: 2 * MINUTES_PER_DAY + 8 * 60, reason: 'The overpass on the market road collapsed.' };
    s.world.hazards.pumpStation = { risk: 1.6, note: 'Landslides on the ridge road', until: 3 * MINUTES_PER_DAY };
  },
  inject: (s) => {
    const spot = freeOutdoorTile(s, 2, 1);
    if (spot) addRubble(s, spot.x, spot.y, 2, 1);
    s.world.director.pending.push({ id: 'aftershock', at: s.minute + 60, data: {} });
    log(s, 'The ground heaves. An earthquake! Expect aftershocks.', 'bad');
  },
  objective: {
    id: 'rescue',
    label: 'Dig out the trapped',
    detail: 'Rescue everyone pinned under rubble.',
    done: (s) => !s.survivors.some((x) => x.trapped) && !s.stats.deaths.some((d) => d.cause === 'being crushed under rubble'),
    progress: (s) => (s.survivors.some((x) => x.trapped && x.alive) ? 'someone is still trapped' : 'everyone is free'),
  },
  events: [],
};

const collapse: CatastropheDef = {
  id: 'collapse',
  name: 'Blackout',
  kind: 'Societal collapse',
  tagline: 'The grid is gone, the shelves are bare, and people are desperate.',
  pressures: ['Almost no fuel and thin pickings everywhere: grow, filter and build your own', 'The Ridge Crew demand tribute and raid weak settlements', 'Low morale makes people leave; traders and drifters arrive', 'No storm: on Day 5 the Ridge Crew attack'],
  intro:
    'The grid went down three weeks ago and never came back. The trucks stopped, then the shops emptied, then people started taking what they needed.\n\nSix of you hold the old Brannock compound now. Someone already drained its fuel. The Ridge Crew run the roads around here and expect to be paid. Make this place self-sufficient, and make it too hard to rob.',
  accent: '#c45a3a',
  haze: '#4a4440',
  tint: 'rgba(70,60,70,0.10)',
  particles: 'smoke',
  climax: { kind: 'raid', label: 'The raid', objective: 'Repel the Ridge Crew', detail: 'Come through their attack on Day 5 with the settlement intact.' },
  mods: { loot: 0.65, morale: -4, opportunity: 1.6, adverse: 1.1 },
  setup: (s) => {
    s.inventory.fuel = 1;
    for (const o of s.objects) {
      if (o.type === 'drums') o.contents = { fuel: 1 };
      if (o.type === 'wreckedCar') {
        o.state = 'siphoned';
        o.issues = ['Fuel cap pried off — already drained'];
      }
    }
    s.locations.garage.loot.fuel = 3;
    s.locations.market.loot = { food: 8, water: 6, meds: 1, scrap: 4 };
    s.locations.pumpStation.loot.fuel = 1;
    s.world.threat = 20;
    disableStorm(s);
    setClimax(s, 'raid', 'The raid', 4 * MINUTES_PER_DAY + 21 * 60);
  },
  inject: (s) => {
    s.world.threat = Math.max(s.world.threat, 40);
    log(s, 'Smoke on every horizon. Law and order are gone: rival groups are taking what they can.', 'bad');
  },
  objective: {
    id: 'selfSufficient',
    label: 'Live off the land',
    detail: 'End with food and water production running and the gate secured.',
    done: (s) => {
      const beds = s.objects.filter((o) => o.type === 'planter' && (o.state === 'growing' || o.state === 'ready')).length;
      const treat = s.objects.some((o) => (o.type === 'sandFilter' || o.type === 'purifier') && o.state === 'operational');
      const gate = s.objects.find((o) => o.type === 'gate');
      return beds >= 2 && treat && gate?.state === 'operational';
    },
    progress: (s) => `threat ${Math.round(s.world.threat)}`,
  },
  events: [
    {
      id: 'tribute',
      when: (s) => s.minute >= MINUTES_PER_DAY + 10 * 60 && s.weather.kind !== 'storm',
      fire: (s) => {
        const radio = s.objects.some((o) => o.type === 'radio' && o.state === 'operational');
        const amara = presentSurvivors(s).some((x) => x.trait === 'empath');
        return {
          id: 'tribute',
          title: 'The Ridge Crew’s envoy',
          body: 'A man in a road-worker’s vest leans on your gate. “This road’s ours. Four rations a week buys you peace. Say no, and we come back with friends.”',
          choices: [
            { id: 'pay', label: 'Pay the four rations', detail: 'Threat falls. Food you will miss.', available: count(s, 'food') >= 4, reason: 'Needs 4 food' },
            { id: 'refuse', label: 'Tell him to get lost', detail: 'Keep the food. They will remember.', available: true },
            {
              id: 'talk',
              label: 'Talk him down',
              detail: 'Point out that a fortified neighbour is worth more alive. Lowers their interest at no cost.',
              available: radio || amara,
              reason: 'Needs the radio (to show you have friends) or Amara',
            },
          ],
          context: {},
        };
      },
      resolve: (s, id) => {
        s.stats.choices.push({ pay: 'Paid the Ridge Crew’s tribute', refuse: 'Refused the Ridge Crew', talk: 'Talked down the Ridge Crew’s envoy' }[id] ?? id);
        if (id === 'pay') {
          consume(s, { food: 4 });
          s.world.threat = Math.max(0, s.world.threat - 15);
          return 'He counts the tins and tips his hat. The road is quiet, for now.';
        }
        if (id === 'talk') {
          s.world.threat = Math.max(0, s.world.threat - 8);
          return '“Fair enough,” he says eventually, and spits. “We’ll see.”';
        }
        s.world.threat = Math.min(100, s.world.threat + 20);
        return 'He shrugs. “Your funeral.”';
      },
    },
    ...climaxEvents('raid'),
  ],
};

const pandemic: CatastropheDef = {
  id: 'pandemic',
  name: 'The Fever',
  kind: 'Pandemic',
  tagline: 'A fever is burning through the region. Someone here already has it.',
  pressures: ['A contagious fever spreads between people who work, eat and sleep close together', 'Quarantine the sick in isolation beds, but they cannot work', 'Medical supplies are the bottleneck; a powered infirmary treats better', 'Strangers and the market pharmacy carry the fever'],
  intro:
    'The fever came up the highway a month ago: two days of nothing, then shaking, burning heat. Some get up again. Many don’t.\n\nTheo was coughing on the walk in. Watch for symptoms, keep the sick apart from the healthy, and stretch the medical supplies. A storm is due later in the week too.',
  accent: '#7fb0a8',
  haze: '#4c5252',
  tint: 'rgba(90,110,120,0.10)',
  particles: 'none',
  climax: { kind: 'storm', label: 'The storm', objective: 'Weather the storm', detail: 'Come through the storm with the settlement intact.' },
  mods: { risk: 1.1, opportunity: 0.9 },
  setup: (s) => {
    const theo = s.survivors.find((x) => x.id === 's-theo');
    if (theo) infect(theo, 'fever', 10);
    s.inventory.meds = (s.inventory.meds ?? 0) + 2;
    s.locations.market.loot.meds = 6;
  },
  inject: (s) => {
    const v = contact(s, 1);
    log(s, `A fever has reached the compound${v ? ` — ${v.name.split(' ')[0]} feels strange` : ''}.`, 'bad');
  },
  objective: {
    id: 'contain',
    label: 'Contain the fever',
    detail: 'Nobody dies of the fever.',
    done: (s) => !s.stats.deaths.some((d) => d.cause === 'the fever'),
    progress: (s) => `${s.survivors.filter((x) => x.alive && x.illness?.kind === 'fever').length} infected`,
  },
  events: [
    {
      id: 'firstFever',
      when: (s) => s.survivors.some((x) => x.alive && !x.away && x.illness?.kind === 'fever' && x.illness.stage === 'sick'),
      fire: (s) => {
        const v = s.survivors.find((x) => x.alive && !x.away && x.illness?.kind === 'fever' && x.illness.stage === 'sick')!;
        return {
          id: 'firstFever',
          title: 'The fever',
          body: `${v.name} collapsed by the mess table, burning up. Everyone has been eating and sleeping within arm’s reach of each other.\n\nIsolated, ${v.name.split(' ')[0]} can’t work, but won’t infect anyone. An isolation bed (build menu) makes quarantine airtight; the medic can treat the fever with medical supplies.`,
          choices: [
            { id: 'isolate', label: `Quarantine ${v.name.split(' ')[0]}`, detail: 'Stops work; stops the spread.', available: true },
            { id: 'keep', label: 'Keep everyone working', detail: 'Labour now, risk later.', available: true },
          ],
          context: { who: v.id },
        };
      },
      resolve: (s, id, ev) => {
        const v = getSurvivor(s, ev.context.who);
        if (id === 'isolate' && v) {
          v.quarantined = true;
          s.stats.choices.push(`Quarantined ${v.name} at the first sign of fever`);
          return `${v.name.split(' ')[0]} is moved apart from the others.`;
        }
        s.stats.choices.push('Kept the feverish working');
        return 'Work goes on. Everyone watches each other’s faces.';
      },
    },
  ],
};

const fallout: CatastropheDef = {
  id: 'fallout',
  name: 'Black Rain',
  kind: 'Nuclear fallout',
  tagline: 'The flash was far away. The fallout is not.',
  pressures: ['Radiation outdoors: every hour outside adds to each person’s dose', 'Rain washes fallout down: storms spike it', 'Boiling no longer makes water safe; filters and the purifier do', 'The ridge (pump station) is downwind and hot'],
  intro:
    'Three nights ago the sky to the north lit up white. Now grey dust settles on everything, and the old dosimeter in the warehouse clicks whenever someone comes in from the yard.\n\nIndoors, the walls stop most of it. Outdoors, every hour adds up. Radiation fades day by day, but rain washes it out of the sky. Plan outdoor work carefully, filter your water, and keep everyone’s dose down.',
  accent: '#b8c25a',
  haze: '#55573c',
  tint: 'rgba(150,160,80,0.10)',
  particles: 'ash',
  climax: { kind: 'storm', label: 'The black rain', objective: 'Weather the black rain', detail: 'Come through the radioactive storm with the settlement intact.' },
  mods: { loot: 1.15, opportunity: 0.8 },
  setup: (s) => {
    s.world.radiation = 9;
    s.inventory.meds = (s.inventory.meds ?? 0) + 1;
  },
  inject: (s) => {
    s.world.radiation = Math.max(s.world.radiation, 8);
    log(s, 'A white flash on the horizon. Hours later, grey dust starts to fall. The dosimeter starts clicking.', 'bad');
  },
  objective: {
    id: 'dose',
    label: 'Keep doses low',
    detail: 'Nobody’s radiation dose goes above 250 mSv.',
    done: (s) => Math.max(...s.survivors.map((x) => x.dose)) < 250 && !s.stats.deaths.some((d) => d.cause === 'radiation sickness'),
    progress: (s) => `highest ${Math.round(Math.max(...s.survivors.map((x) => x.dose)))} mSv`,
  },
  events: [
    {
      id: 'firstDose',
      when: (s) => s.survivors.some((x) => x.alive && x.dose >= 100),
      fire: (s) => {
        const v = s.survivors.find((x) => x.alive && x.dose >= 100)!;
        log(s, `${v.name} has absorbed ${Math.round(v.dose)} mSv and feels sick. Keep them indoors; the medic can treat radiation sickness with medical supplies.`, 'warn');
        return null;
      },
    },
  ],
};

const outbreak: CatastropheDef = {
  id: 'outbreak',
  name: 'The Infected',
  kind: 'Zombie outbreak',
  tagline: 'They follow noise. Everything that keeps you alive makes noise.',
  pressures: ['The infected mass outside the fence, drawn by the generator, work and lights', 'Build barricades and secure the gate; breaches cause injuries and bites', 'Bites turn into a fatal fever unless the medic treats them in time', 'No storm: on Day 5 a horde hits the fence'],
  intro:
    'Nobody knows where it started. The infected don’t sleep, don’t stop, and come towards any sound.\n\nThe Brannock fence is still standing. The generator would change everything, and every infected for a mile would hear it. Build defences, choose when to make noise, and treat bites before they turn.',
  accent: '#a85a4a',
  haze: '#4e3c36',
  tint: 'rgba(120,70,60,0.10)',
  particles: 'none',
  climax: { kind: 'horde', label: 'The horde', objective: 'Survive the horde', detail: 'Come through the Day 5 horde with the settlement intact.' },
  mods: { risk: 1.6, loot: 1.2, opportunity: 0.8 },
  setup: (s) => {
    s.world.horde = 15;
    s.inventory.meds = (s.inventory.meds ?? 0) + 2;
    disableStorm(s);
    setClimax(s, 'horde', 'The horde', 4 * MINUTES_PER_DAY + 22 * 60);
  },
  inject: (s) => {
    s.world.horde = Math.max(s.world.horde, 25);
    log(s, 'Shapes stagger out of the treeline. The infected have found the compound.', 'bad');
  },
  objective: {
    id: 'noTurn',
    label: 'Nobody turns',
    detail: 'Nobody dies of an infected bite.',
    done: (s) => !s.stats.deaths.some((d) => d.cause === 'an infected bite'),
    progress: (s) => `${s.survivors.filter((x) => x.alive && x.illness?.kind === 'bite').length} bitten`,
  },
  events: [
    ...climaxEvents('horde'),
    {
      id: 'firstBite',
      when: (s) => s.survivors.some((x) => x.alive && x.illness?.kind === 'bite'),
      fire: (s) => {
        const v = s.survivors.find((x) => x.alive && x.illness?.kind === 'bite')!;
        log(s, `${v.name} has been bitten. The wound will turn into a killing fever. The medic can stop it with 2 medical supplies — the sooner the better.`, 'bad');
        return null;
      },
    },
  ],
};

export const CATASTROPHES: Record<CatastropheId, CatastropheDef> = { storm, quake, collapse, pandemic, fallout, outbreak };
export const CATASTROPHE_IDS = Object.keys(CATASTROPHES) as CatastropheId[];

function disableStorm(s: GameState): void {
  s.weather.stormStart = NEVER;
  s.weather.stormEnd = NEVER + 1;
}

function setClimax(s: GameState, kind: ClimaxKind, label: string, at: number): void {
  s.world.climax = { kind, label, at, end: at + 6 * 60, known: false, resolved: false };
}

export function scheduleSquall(s: GameState, minutes: number): void {
  s.weather.rainWindows.push({ start: s.minute, end: s.minute + minutes, heavy: 1 });
}

// ---------------------------------------------------------------- new games

export interface NewGameOptions {
  catastrophe: CatastropheId;
  difficulty: Difficulty;
  mode: GameMode;
  random?: boolean;
  extra?: CatastropheId[];
  supplies?: 'scarce' | 'normal' | 'plentiful';
  director?: 'calm' | 'normal' | 'chaotic';
}

export function applyScenario(s: GameState, o: NewGameOptions): void {
  const w = s.world;
  w.catastrophe = o.catastrophe;
  w.difficulty = o.difficulty;
  w.mode = o.mode;
  w.random = !!o.random;
  w.extra = (o.extra ?? []).filter((x) => x !== o.catastrophe);
  w.director.intensity = o.director === 'calm' ? 0.5 : o.director === 'chaotic' ? 1.8 : 1;
  CATASTROPHES[o.catastrophe].setup(s);
  for (const x of w.extra) CATASTROPHES[x].setup(s);
  if (o.difficulty === 'hard' && o.catastrophe === 'storm') {
    // Brutal Storm Season: the storm comes a day early and stays longer.
    s.weather.stormStart -= 20 * 60;
    s.weather.stormEnd += 4 * 60 - 20 * 60;
  }
  if (w.climax.kind === 'storm') {
    w.climax.at = s.weather.stormStart;
    w.climax.end = s.weather.stormEnd;
    w.climax.label = CATASTROPHES[o.catastrophe].climax.kind === 'storm' ? CATASTROPHES[o.catastrophe].climax.label : 'The storm';
  }
  let mult = DIFFICULTY[o.difficulty].supplies;
  if (o.supplies === 'scarce') mult *= 0.6;
  if (o.supplies === 'plentiful') mult *= 1.6;
  if (mult !== 1) {
    for (const k of ['food', 'water', 'scrap', 'mech', 'elec', 'fuel', 'meds'] as ItemId[]) {
      const v = s.inventory[k];
      if (v) s.inventory[k] = Math.max(k === 'food' || k === 'water' ? 4 : 0, Math.round(v * mult));
    }
  }
}

// ---------------------------------------------------------------- world tick

const HALF_LIFE = 36 * 60;

export function tickWorld(s: GameState): void {
  const w = s.world;
  // Keep the storm climax in step with the weather system.
  if (w.climax.kind === 'storm') {
    w.climax.known = s.weather.stormForecastKnown;
    w.climax.resolved = s.weather.stormResolved;
  }
  if (w.radiation > 0) w.radiation = Math.max(isActive(s, 'fallout') ? 0.4 : 0, w.radiation * Math.pow(0.5, 1 / HALF_LIFE));

  // Noise: engines, tools and lights.
  let target = 0;
  const gen = s.objects.find((o) => o.type === 'generator');
  if (gen?.data.running) target += 55;
  if (s.jobs.some((j) => j.phase === 'work' && (j.kind === 'build' || j.kind === 'dismantle' || j.kind === 'craft' || j.kind === 'repair'))) target += 20;
  if (isNight(s.minute)) target += 6 * s.objects.filter((o) => o.type === 'lamp' && o.state === 'operational' && o.powered).length;
  if (s.objects.some((o) => o.type === 'windTurbine' && o.state === 'operational')) target += 5;
  w.noise += (Math.min(100, target) - w.noise) * 0.02;

  if (isActive(s, 'outbreak')) {
    const goal = 12 + dayOf(s.minute) * 7 + w.noise * 0.7;
    w.horde = Math.max(0, Math.min(100, w.horde + (goal - w.horde) * 0.003));
  }
  if (isActive(s, 'collapse')) w.threat = Math.min(100, w.threat + 4 / MINUTES_PER_DAY);
  if (s.minute % MINUTES_PER_DAY === 6 * 60) s.flags.rawDrinks = 0;

  // Flood: storm rain over the low ground, held back by levees.
  if (isActive(s, 'quake') || w.flood > 0) {
    const levees = s.objects.filter((o) => o.type === 'levee' && o.state === 'operational').length;
    const raining = s.weather.kind === 'storm' || s.weather.rain >= 0.9;
    const goal = raining && isActive(s, 'quake') ? (levees >= 2 ? 15 : 85) : 0;
    w.flood += goal > w.flood ? Math.min(goal - w.flood, 12 / 60) : -Math.min(w.flood - goal, 6 / 60);
    if (w.flood >= 50 && !s.flags.floodHit) flood(s);
    if (w.flood < 5) s.flags.floodHit = false;
  }

  // Fires burn for three hours, then destroy what they're on. Heavy rain puts them out.
  for (const o of s.objects) {
    if (!o.data.burning) continue;
    if (s.weather.rain >= 0.8) {
      o.data.burning = 0;
      log(s, `The rain puts out the fire on the ${objectName(o).toLowerCase()}.`, 'good');
      continue;
    }
    o.data.burning++;
    if (o.data.burning > 180) {
      o.data.burning = 0;
      if (o.type === 'planter') {
        o.state = 'damaged';
        o.data.growth = 0;
        o.issues = ['Burnt'];
      } else if (o.type === 'generator' || o.type === 'waterPump' || o.type === 'workbench') {
        o.state = 'broken';
        o.condition = Math.min(o.condition, 20);
        o.issues = ['Burnt out'];
        o.data.running = 0;
      } else {
        o.state = 'dismantled';
      }
      log(s, `The ${objectName(o).toLowerCase()} burnt out.`, 'bad');
      s.stats.stormDamage.push(`${objectName(o).toLowerCase()} burnt`);
    }
  }
}

function flood(s: GameState): void {
  s.flags.floodHit = true;
  const hits: string[] = [];
  for (const o of s.objects) {
    if (o.y < 21) continue;
    if (o.type === 'planter' && (o.state === 'growing' || o.state === 'ready' || o.state === 'empty')) {
      o.state = 'damaged';
      o.data.growth = 0;
      o.issues = ['Drowned by floodwater'];
      hits.push('a planter drowned');
    } else if (o.type === 'rainCatcher' && o.state === 'operational') {
      o.state = 'dismantled';
      hits.push('a rain catcher swept away');
    } else if (o.type === 'lamp' && o.state === 'operational') {
      o.state = 'broken';
      o.issues = ['Shorted by floodwater'];
      hits.push('a lamp shorted');
    }
  }
  s.flags.contaminatedUntil = s.minute + 2 * MINUTES_PER_DAY;
  s.stats.stormDamage.push('floodwater over the low ground', ...hits);
  log(s, `The creek breaks its banks. Floodwater pours across the growing plot${hits.length ? ` — ${hits.join(', ')}` : ''}. The well is contaminated: untreated water is twice as dangerous for two days.`, 'bad');
}

/** All event definitions contributed by active catastrophes. */
export function catastropheEvents(s: GameState): EventDef[] {
  return activeDefs(s).flatMap((d) => d.events);
}

export function allCatastropheEvents(): EventDef[] {
  return CATASTROPHE_IDS.flatMap((id) => CATASTROPHES[id].events);
}
