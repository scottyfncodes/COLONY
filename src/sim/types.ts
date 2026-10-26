// Core typed data structures for the COLONY simulation.
// The simulation is pure data: everything that matters lives in GameState,
// which is serialisable to JSON for save/load and deterministic replays.

export type ItemId =
  | 'scrap'
  | 'mech'
  | 'elec'
  | 'fuel'
  | 'battery'
  | 'tools'
  | 'food'
  | 'water'
  | 'rawWater'
  | 'meds'
  | 'engine'
  | 'filter';

export type Items = Partial<Record<ItemId, number>>;

export type Skill = 'mechanical' | 'electrical' | 'medical' | 'construction' | 'scavenging';

export type Role = 'Mechanic' | 'Electrician' | 'Medic' | 'Builder' | 'Scavenger' | 'Generalist';

export type TraitId =
  | 'tinkerer'
  | 'nightOwl'
  | 'empath'
  | 'tough'
  | 'lightFooted'
  | 'bigAppetite'
  | 'steady';

export interface Point {
  x: number;
  y: number;
}

export type Activity =
  | 'idle'
  | 'walking'
  | 'working'
  | 'eating'
  | 'drinking'
  | 'sleeping'
  | 'hauling'
  | 'fetching'
  | 'sheltering'
  | 'away'
  | 'trapped'
  | 'dead';

export type NeedKind = 'eat' | 'drink' | 'sleep' | 'shelter';

export interface NeedAction {
  kind: NeedKind;
  target: Point;
  arrived: boolean;
  timer: number;
  bedId: string | null;
}

export interface Survivor {
  id: string;
  name: string;
  role: Role;
  trait: TraitId;
  skills: Record<Skill, number>;
  look: { skin: string; hair: string; hairStyle: number; shirt: string };
  x: number;
  y: number;
  path: Point[];
  goal: Point | null;
  facing: 1 | -1;
  health: number;
  hunger: number; // 100 = full, 0 = starving
  thirst: number; // 100 = hydrated
  energy: number; // 100 = rested
  morale: number;
  sick: number; // game minutes of illness remaining
  injury: number; // 0 none .. 100 severe
  alive: boolean;
  causeOfDeath: string | null;
  activity: Activity;
  jobId: string | null;
  need: NeedAction | null;
  moveTarget: Point | null;
  autoWork: boolean;
  away: boolean; // on an expedition
  relationships: Record<string, number>;
  workedMinutes: number;
  joinedDay: number;
  sleptInBed: boolean;
  lastAte: number;
  /** Accumulated radiation dose (fallout). */
  dose: number;
  /** Contagious fever or an infected bite. */
  illness: Illness | null;
  /** Pinned under rubble and unable to move until dug out. */
  trapped: boolean;
  /** Isolated in the infirmary: does not work, does not spread illness. */
  quarantined: boolean;
  /** Recovered from the fever; cannot catch it again. */
  immune?: boolean;
}

export interface Illness {
  kind: 'fever' | 'bite';
  stage: 'incubating' | 'sick';
  /** Minutes remaining in the current stage. */
  t: number;
}

export type ObjectType =
  | 'depot'
  | 'generator'
  | 'forklift'
  | 'batteryBank'
  | 'waterPump'
  | 'waterTank'
  | 'pipes'
  | 'scrapPile'
  | 'wreckedCar'
  | 'workbench'
  | 'radio'
  | 'gate'
  | 'planter'
  | 'cot'
  | 'storageRack'
  | 'rainCatcher'
  | 'sandFilter'
  | 'purifier'
  | 'windTurbine'
  | 'lamp'
  | 'crate'
  | 'shelf'
  | 'drums'
  | 'table'
  | 'rubble'
  | 'barricade'
  | 'levee'
  | 'infirmary';

export interface WorldObject {
  id: string;
  type: ObjectType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** e.g. broken | damaged | operational | dismantled | stripped | site | overgrown | empty | growing | ready */
  state: string;
  condition: number;
  reinforced: boolean;
  on: boolean;
  powered: boolean;
  /** Type-specific numeric data: growth, moisture, loot remaining, site progress, etc. */
  data: Record<string, number>;
  /** Items held by this object (loot piles, overflow crates). */
  contents: Items;
  issues: string[];
  /** Blueprint type being built while state === 'site'. */
  label?: string;
}

export type JobKind =
  | 'repair'
  | 'dismantle'
  | 'repurpose'
  | 'salvage'
  | 'build'
  | 'reinforce'
  | 'craft'
  | 'clear'
  | 'plant'
  | 'harvest'
  | 'water'
  | 'treat'
  | 'service';

export type JobPhase = 'queued' | 'fetch' | 'travel' | 'work' | 'haul';

export interface Job {
  id: string;
  kind: JobKind;
  actionId: string;
  targetId: string; // object id or survivor id (for treat)
  label: string;
  assigneeId: string | null;
  preferredId: string | null;
  phase: JobPhase;
  progress: number;
  required: number; // work minutes at rate 1.0
  inputs: Items;
  needsTools: boolean;
  /** Materials taken from inventory and currently carried by the worker. */
  staged: Items;
  skill: Skill | null;
  auto: boolean;
  createdAt: number;
  blockedReason: string | null;
  exposed: boolean;
}

export type WeatherKind = 'clear' | 'overcast' | 'rain' | 'storm';

export interface Weather {
  kind: WeatherKind;
  wind: number; // 0..1
  rain: number; // 0..1
  stormStart: number; // absolute minute
  stormEnd: number;
  stormForecastKnown: boolean;
  stormResolved: boolean;
  rainWindows: { start: number; end: number; heavy?: number }[];
}

export type LocationId = 'garage' | 'market' | 'pumpStation';

export interface LocationState {
  id: LocationId;
  visits: number;
  loot: Items;
  decisionDone: boolean;
  discovered: string[];
}

export type ExpeditionPhase = 'outbound' | 'searching' | 'decision' | 'returning' | 'done';

export interface Expedition {
  id: string;
  destination: LocationId;
  members: string[];
  packed: Items;
  cargo: Items;
  vehicle: boolean;
  phase: ExpeditionPhase;
  elapsed: number;
  legMinutes: number;
  searchMinutes: number;
  log: string[];
  pendingDecision: string | null;
  bonusSearch: number;
  startedAt: number;
}

export interface EventChoice {
  id: string;
  label: string;
  detail: string;
  available: boolean;
  reason?: string;
}

export interface PendingEvent {
  id: string; // event definition id
  title: string;
  body: string;
  choices: EventChoice[];
  context: Record<string, string>;
}

export interface LogEntry {
  t: number;
  text: string;
  tone: 'info' | 'good' | 'warn' | 'bad';
}

export interface Ledger {
  produced: Items;
  consumed: Items;
}

export interface Flags {
  [key: string]: number | string | boolean;
}

export type ScenarioStatus = 'playing' | 'won' | 'lost';

export interface ScenarioResult {
  status: ScenarioStatus;
  grade: string;
  headline: string;
  lines: string[];
  objectives: { id: string; label: string; done: boolean }[];
}

export type CatastropheId = 'storm' | 'quake' | 'collapse' | 'pandemic' | 'fallout' | 'outbreak';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type GameMode = 'survival' | 'sandbox';
export type ClimaxKind = 'storm' | 'raid' | 'horde';

/** A queued follow-up from the event director (a warning now, consequences later). */
export interface DirectorPending {
  id: string;
  at: number;
  data: Record<string, string | number>;
}

/** Catastrophe-driven world conditions shared by every system. */
export interface WorldConditions {
  catastrophe: CatastropheId;
  /** Further catastrophes layered on in sandbox mode. */
  extra: CatastropheId[];
  difficulty: Difficulty;
  mode: GameMode;
  random: boolean;
  /** Outdoor radiation in mSv per hour (fallout). */
  radiation: number;
  /** Infected massing outside the fence, 0–100 (outbreak). */
  horde: number;
  /** Recent noise from machinery and work, 0–100. Attracts the infected. */
  noise: number;
  /** Hostility of rival groups, 0–100 (collapse). */
  threat: number;
  /** Floodwater depth over the low ground, 0–100. */
  flood: number;
  routes: Partial<Record<LocationId, { until: number; reason: string }>>;
  hazards: Partial<Record<LocationId, { risk: number; note: string; until: number }>>;
  climax: { kind: ClimaxKind; label: string; at: number; end: number; known: boolean; resolved: boolean };
  director: {
    intensity: number;
    lastAdverse: number;
    lastAny: number;
    counts: Record<string, number>;
    last: Record<string, number>;
    pending: DirectorPending[];
  };
}

export interface GameState {
  version: number;
  seed: number;
  rngState: number;
  minute: number; // absolute game minutes since Day 1 00:00
  nextId: number;
  survivors: Survivor[];
  objects: WorldObject[];
  jobs: Job[];
  inventory: Items;
  ledger: Ledger;
  power: {
    supply: number;
    demand: number;
    stored: number;
    capacity: number;
    deficit: boolean;
    fuelBurn: number; // per hour, informational
  };
  water: { rawCap: number; cleanCap: number; rawIn: number; cleanIn: number };
  weather: Weather;
  locations: Record<LocationId, LocationState>;
  expeditions: Expedition[];
  events: { fired: Record<string, number>; pending: PendingEvent | null };
  log: LogEntry[];
  flags: Flags;
  trust: { kessler: number };
  stats: {
    deaths: { name: string; cause: string; minute: number }[];
    choices: string[];
    powerHours: number;
    cleanWaterMade: number;
    foodGrown: number;
    built: number;
    repaired: number;
    dismantled: number;
    stormDamage: string[];
  };
  objectivesDone: Record<string, number>;
  result: ScenarioResult | null;
  world: WorldConditions;
}

export type Command =
  | { type: 'queueAction'; objectId: string; actionId: string; assigneeId?: string | null }
  | { type: 'treat'; patientId: string; assigneeId?: string | null }
  | { type: 'cancelJob'; jobId: string }
  | { type: 'assignJob'; jobId: string; survivorId: string | null }
  | { type: 'move'; survivorId: string; x: number; y: number }
  | { type: 'build'; blueprint: ObjectType; x: number; y: number; assigneeId?: string | null }
  | { type: 'toggle'; objectId: string }
  | { type: 'setAutoWork'; survivorId: string; value: boolean }
  | {
      type: 'expedition';
      destination: LocationId;
      members: string[];
      packed: Items;
      vehicle: boolean;
    }
  | { type: 'choose'; choiceId: string }
  | { type: 'quarantine'; survivorId: string; value: boolean }
  | { type: 'sandbox'; action: SandboxAction };

export type SandboxAction =
  | { kind: 'addCatastrophe'; catastrophe: CatastropheId }
  | { kind: 'setCondition'; key: 'radiation' | 'horde' | 'threat' | 'flood'; value: number }
  | { kind: 'triggerEvent'; eventId: string }
  | { kind: 'weather'; weather: 'squall' | 'rain' | 'clear' }
  | { kind: 'supplies'; amount: 'some' | 'lots' };

export interface CommandResult {
  ok: boolean;
  message: string;
}
