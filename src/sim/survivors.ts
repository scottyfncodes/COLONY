import { findAction } from './actions';
import { consume, consumeUpTo, count, log } from './inventory';
import {
  completeJob,
  finishHaul,
  getObject,
  getSurvivor,
  jobWaitingOn,
  needsFetch,
  releaseJob,
  stageInputs,
  workRate,
} from './jobs';
import { chance, nextRandom } from './rng';
import { mods, radiationNow } from './catastrophes';
import { grieve, socialMorale } from './social';
import { hourOf, isNight, minuteOfDay } from './time';
import { accessTiles, BUILDINGS, findPath, isSheltered, nearestWalkable, walkable, type Building } from './world';
import type { GameState, Items, Job, NeedAction, Point, Survivor, WorldObject } from './types';

export const WALK_SPEED = 0.5; // tiles per game minute

export function aliveSurvivors(state: GameState): Survivor[] {
  return state.survivors.filter((s) => s.alive);
}

export function presentSurvivors(state: GameState): Survivor[] {
  return state.survivors.filter((s) => s.alive && !s.away);
}

export function stormActive(state: GameState): boolean {
  return state.weather.kind === 'storm';
}

// ---------------------------------------------------------------- needs

export function first(s: Survivor): string {
  return s.name.split(' ')[0];
}

/** Per-minute decay of needs and health. `carry` is the pack used while away from the compound. */
/**
 * Per-minute decay of needs and health. `carry` is the pack used while away from the compound;
 * `outdoorRad` overrides the radiation the survivor is exposed to (expeditions).
 */
export function updateNeeds(state: GameState, s: Survivor, carry?: Items, outdoorRad?: number): void {
  const sleeping = s.activity === 'sleeping' || s.activity === 'trapped';
  const working = s.activity === 'working';
  const moving = s.activity === 'walking' || s.activity === 'hauling' || s.activity === 'fetching' || s.away;
  const slow = sleeping ? 0.5 : 1;
  const m = mods(state);
  const radSick = s.dose > 100 ? 1.3 : 1;
  s.hunger = Math.max(0, s.hunger - (4 / 60) * slow * m.needs * radSick * (s.trait === 'bigAppetite' ? 1.3 : 1));
  s.thirst = Math.max(0, s.thirst - (4.5 / 60) * slow * m.needs * (s.illness?.stage === 'sick' ? 1.3 : 1) * (working && !isSheltered(s.x, s.y) ? 1.15 : 1));
  // Radiation: walls stop most of it.
  const rad = outdoorRad ?? radiationNow(state) * (isSheltered(s.x, s.y) ? 0.08 : 1);
  if (rad > 0) s.dose += rad / 60;
  if (sleeping) {
    s.energy = Math.min(100, s.energy + (s.sleptInBed ? 13 : 7) / 60);
  } else {
    let drain = working ? 6 : moving ? 4.5 : 2.5;
    if (s.trait === 'bigAppetite') drain *= 0.75;
    if (s.trait === 'nightOwl' && isNight(state.minute)) drain *= 0.8;
    s.energy = Math.max(0, s.energy - drain / 60);
  }

  // While away, survivors eat and drink from their packs.
  if (carry) {
    if (s.thirst < 40 && (carry.water ?? 0) > 0) {
      const v = consumeUpTo(state, 'water', 1.5, carry);
      s.thirst = Math.min(100, s.thirst + 30 * v);
    }
    if (s.hunger < 40 && (carry.food ?? 0) > 0) {
      const v = consumeUpTo(state, 'food', 0.5, carry);
      s.hunger = Math.min(100, s.hunger + 90 * v);
    }
  }

  let dmg = 0;
  const causes: string[] = [];
  if (s.hunger <= 0) {
    dmg += 1.5;
    causes.push('starvation');
  }
  if (s.thirst <= 0) {
    dmg += 4;
    causes.push('dehydration');
  }
  if (s.sick > 0) {
    dmg += 1;
    s.sick = Math.max(0, s.sick - 1);
    causes.push('illness from bad water');
  }
  if (s.injury > 50) {
    dmg += 0.6;
    causes.push('untreated injuries');
  }
  if (s.energy <= 0) {
    dmg += 0.5;
    causes.push('exhaustion');
  }
  if (s.trapped) {
    dmg += 1.5;
    causes.unshift('being crushed under rubble');
  }
  if (s.dose > 100) {
    dmg += s.dose > 400 ? 3 : s.dose > 250 ? 1.6 : 0.5;
    causes.unshift('radiation sickness');
  }
  if (s.illness) {
    const ill = s.illness;
    ill.t--;
    if (ill.stage === 'incubating' && ill.t <= 0) {
      ill.stage = 'sick';
      ill.t = (ill.kind === 'fever' ? 40 : 30) * 60;
      log(state, ill.kind === 'fever' ? `${first(s)} is burning up: the fever has taken hold.` : `${first(s)}’s bite has turned feverish. Without treatment it will kill them.`, 'bad');
    } else if (ill.stage === 'sick') {
      if (ill.kind === 'fever') {
        const bed = s.quarantined && s.need?.bedId ? state.objects.find((o) => o.id === s.need!.bedId && o.type === 'infirmary') : undefined;
        dmg += bed ? (bed.powered ? 0.5 : 0.9) : 1.6;
        causes.unshift('the fever');
      } else {
        dmg += 3;
        causes.unshift('an infected bite');
      }
      s.energy = Math.max(0, s.energy - 1.5 / 60);
      if (ill.t <= 0) {
        s.illness = null;
        if (ill.kind === 'fever') {
          s.immune = true;
          log(state, `${first(s)} has beaten the fever${s.quarantined ? ' and can leave quarantine' : ''}.`, 'good');
        }
      }
    }
  }
  if (s.trait === 'tough') dmg *= 0.6;
  if (dmg > 0) {
    s.health -= dmg / 60;
  } else if (s.hunger > 30 && s.thirst > 30) {
    s.health = Math.min(100, s.health + (sleeping ? 1.2 : 0.5) / 60);
    if (sleeping && s.injury > 0) s.injury = Math.max(0, s.injury - 0.4 / 60);
  }

  // Morale drifts toward a target driven by living conditions.
  let target = 50;
  target += s.hunger > 50 ? 6 : s.hunger < 20 ? -18 : 0;
  target += s.thirst > 50 ? 6 : s.thirst < 20 ? -18 : 0;
  target += s.sleptInBed ? 6 : -10;
  target += s.health < 50 ? -10 : 0;
  if (state.power.supply > 0 && !state.power.deficit) target += 6;
  if (state.survivors.some((o) => o.alive && !o.away && o.trait === 'empath' && o.id !== s.id)) target += 8;
  target += socialMorale(state, s);
  target += Number(state.flags.moraleMod ?? 0) + m.morale;
  target -= state.stats.deaths.length * 12;
  if (stormActive(state)) target -= 6;
  target = Math.max(5, Math.min(95, target));
  s.morale += Math.sign(target - s.morale) * Math.min(Math.abs(target - s.morale), 2.5 / 60);

  if (s.health <= 0) {
    killSurvivor(state, s, causes[0] ?? 'their wounds');
  }
}

export function killSurvivor(state: GameState, s: Survivor, cause: string): void {
  if (!s.alive) return;
  s.health = 0;
  s.alive = false;
  s.activity = 'dead';
  s.causeOfDeath = cause;
  s.need = null;
  s.path = [];
  const job = state.jobs.find((j) => j.id === s.jobId);
  if (job) releaseJob(state, job);
  s.jobId = null;
  state.stats.deaths.push({ name: s.name, cause, minute: state.minute });
  log(state, `${s.name} has died of ${cause}.`, 'bad');
  grieve(state, s);
}

// ---------------------------------------------------------------- movement

function sameTile(a: Point, b: Point): boolean {
  return Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.y) === Math.floor(b.y);
}

export function atTile(s: Survivor, p: Point): boolean {
  return s.path.length === 0 && sameTile(s, p);
}

export function moveSpeed(s: Survivor): number {
  let v = WALK_SPEED;
  if (s.injury > 40) v *= 0.7;
  if (s.energy < 20) v *= 0.8;
  if (s.trait === 'lightFooted') v *= 1.1;
  return v;
}

/** Step along the current path. */
function advance(s: Survivor): void {
  let budget = moveSpeed(s);
  while (budget > 0 && s.path.length) {
    const p = s.path[0];
    const dx = p.x - s.x;
    const dy = p.y - s.y;
    const d = Math.hypot(dx, dy);
    if (Math.abs(dx - dy) > 0.01) s.facing = dx - dy > 0 ? 1 : -1;
    if (d <= budget) {
      s.x = p.x;
      s.y = p.y;
      s.path.shift();
      budget -= d;
    } else {
      s.x += (dx / d) * budget;
      s.y += (dy / d) * budget;
      budget = 0;
    }
  }
}

/**
 * Walk toward a goal tile. Returns 'arrived', 'moving' or 'blocked'.
 * Paths are recomputed only when the goal changes or the path ran out early.
 */
export function walkTo(state: GameState, s: Survivor, occ: Uint8Array, goal: Point): 'arrived' | 'moving' | 'blocked' {
  if (atTile(s, goal) && Math.abs(s.x - (Math.floor(goal.x) + 0.5)) < 0.05 && Math.abs(s.y - (Math.floor(goal.y) + 0.5)) < 0.05) {
    s.goal = null;
    return 'arrived';
  }
  if (!s.goal || !sameTile(s.goal, goal) || s.path.length === 0) {
    const p = findPath(occ, s, goal);
    if (!p) {
      s.goal = null;
      return 'blocked';
    }
    s.goal = { x: Math.floor(goal.x), y: Math.floor(goal.y) };
    s.path = p;
  }
  // Path may have become invalid because something was built on it.
  if (s.path.length && !walkable(occ, Math.floor(s.path[0].x), Math.floor(s.path[0].y))) {
    s.path = [];
    s.goal = null;
    return 'moving';
  }
  advance(s);
  void state;
  return 'moving';
}

/** Best tile from which to work on an object: the reachable access tile with the shortest path. */
export function approachTile(occ: Uint8Array, s: Survivor, o: { x: number; y: number; w: number; h: number }): Point | null {
  const tiles = accessTiles(occ, o);
  let best: Point | null = null;
  let bestD = Infinity;
  for (const t of tiles) {
    const crow = Math.hypot(t.x + 0.5 - s.x, t.y + 0.5 - s.y);
    if (crow >= bestD) continue;
    const p = findPath(occ, s, t);
    if (!p) continue;
    let len = 0;
    let px = s.x;
    let py = s.y;
    for (const q of p) {
      len += Math.hypot(q.x - px, q.y - py);
      px = q.x;
      py = q.y;
    }
    if (len < bestD) {
      bestD = len;
      best = t;
    }
  }
  return best;
}

function depotTile(state: GameState, occ: Uint8Array, s: Survivor): Point | null {
  const depot = getObject(state, 'depot')!;
  return approachTile(occ, s, depot);
}

// ---------------------------------------------------------------- needs-driven behaviour

function sleepWindow(state: GameState, s: Survivor): boolean {
  const h = hourOf(state.minute);
  if (s.trait === 'nightOwl') return h >= 1 && h < 8;
  return h >= 22 || h < 6;
}

function freeBed(state: GameState, s: Survivor): WorldObject | null {
  const taken = new Set(state.survivors.filter((o) => o.alive && o.need?.kind === 'sleep' && o.need.bedId && o.id !== s.id).map((o) => o.need!.bedId));
  const beds = state.objects.filter((o) => o.type === 'cot' && o.state === 'operational' && !taken.has(o.id));
  beds.sort((a, b) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y));
  return beds[0] ?? null;
}

const SHELTER_TILES: Point[] = (() => {
  const out: Point[] = [];
  const pick = (b: Building) => {
    for (let y = b.y0 + 1; y < b.y1; y++) for (let x = b.x0 + 1; x < b.x1; x++) out.push({ x, y });
  };
  BUILDINGS.forEach(pick);
  return out;
})();

function shelterTile(state: GameState, occ: Uint8Array, s: Survivor): Point | null {
  const claimed = new Set(
    state.survivors.filter((o) => o.id !== s.id && o.need && o.need.kind !== 'sleep').map((o) => `${o.need!.target.x},${o.need!.target.y}`),
  );
  const cands = SHELTER_TILES.filter((p) => walkable(occ, p.x, p.y) && !claimed.has(`${p.x},${p.y}`));
  cands.sort((a, b) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y));
  return cands[0] ?? null;
}

function floorSpot(state: GameState, occ: Uint8Array, s: Survivor): Point | null {
  const bunk = BUILDINGS.find((b) => b.id === 'bunkhouse')!;
  const claimed = new Set(state.survivors.filter((o) => o.id !== s.id && o.need).map((o) => `${o.need!.target.x},${o.need!.target.y}`));
  for (let y = bunk.y1 - 1; y > bunk.y0; y--) {
    for (let x = bunk.x1 - 1; x > bunk.x0; x--) {
      if (walkable(occ, x, y) && !claimed.has(`${x},${y}`)) return { x, y };
    }
  }
  return shelterTile(state, occ, s);
}

function currentJob(state: GameState, s: Survivor): Job | undefined {
  return s.jobId ? state.jobs.find((j) => j.id === s.jobId) : undefined;
}

function chooseNeed(state: GameState, s: Survivor, occ: Uint8Array): NeedAction | null {
  const job = currentJob(state, s);
  const mod = minuteOfDay(state.minute);
  const mealtime = (mod >= 7 * 60 && mod < 8 * 60) || (mod >= 18 * 60 && mod < 19 * 60);
  const anyWater = count(state, 'water') > 0 || count(state, 'rawWater') > 0;
  if (s.thirst < 40 && anyWater) {
    const t = depotTile(state, occ, s);
    if (t) return { kind: 'drink', target: t, arrived: false, timer: 10, bedId: null };
  }
  if ((s.hunger < 40 || (mealtime && s.hunger < 70)) && count(state, 'food') >= 0.5) {
    const t = depotTile(state, occ, s);
    if (t) return { kind: 'eat', target: t, arrived: false, timer: 20, bedId: null };
  }
  const tired = s.energy < 12 || (sleepWindow(state, s) && s.energy < 85);
  // A survivor in the middle of hauling finishes the trip first unless exhausted.
  if (tired && !(job && job.phase === 'haul' && s.energy > 5)) {
    const bed = freeBed(state, s);
    if (bed) {
      const t = approachTile(occ, s, bed);
      if (t) return { kind: 'sleep', target: t, arrived: false, timer: 0, bedId: bed.id };
    }
    const f = floorSpot(state, occ, s);
    if (f) return { kind: 'sleep', target: f, arrived: false, timer: 0, bedId: null };
  }
  if (stormActive(state) && !isSheltered(s.x, s.y) && !(job && !job.exposed)) {
    const t = shelterTile(state, occ, s);
    if (t) return { kind: 'shelter', target: t, arrived: false, timer: 0, bedId: null };
  }
  return null;
}

function runNeed(state: GameState, s: Survivor, occ: Uint8Array): void {
  const n = s.need!;
  if (!n.arrived) {
    const r = walkTo(state, s, occ, n.target);
    s.activity = 'walking';
    if (r === 'blocked') {
      s.need = null;
      return;
    }
    if (r !== 'arrived') return;
    n.arrived = true;
    if (n.kind === 'sleep' && n.bedId) {
      const bed = getObject(state, n.bedId);
      if (bed) {
        s.x = bed.x + 0.5;
        s.y = bed.y + 0.5;
      }
    }
  }
  switch (n.kind) {
    case 'drink': {
      s.activity = 'drinking';
      if (--n.timer > 0) return;
      if (count(state, 'water') >= 0.1) {
        const v = consumeUpTo(state, 'water', 1.5);
        s.thirst = Math.min(100, s.thirst + 30 * v);
      } else if (count(state, 'rawWater') >= 0.1) {
        const v = consumeUpTo(state, 'rawWater', 1.5);
        s.thirst = Math.min(100, s.thirst + 30 * v);
        state.flags.rawDrinks = Number(state.flags.rawDrinks ?? 0) + 1;
        const contaminated = Number(state.flags.contaminatedUntil ?? 0) > state.minute ? 2 : 1;
        if (s.sick <= 0 && chance(state, Math.min(0.9, 0.4 * mods(state).rawSick * contaminated))) {
          s.sick = 24 * 60;
          log(state, `${first(s)} drank untreated water and fell ill.`, 'bad');
        }
        if (radiationNow(state) > 0) s.dose += 12;
      }
      s.need = null;
      s.activity = 'idle';
      return;
    }
    case 'eat': {
      s.activity = 'eating';
      if (--n.timer > 0) return;
      if (count(state, 'food') >= 0.5) {
        consume(state, { food: 0.5 });
        s.hunger = Math.min(100, s.hunger + 45);
        s.lastAte = state.minute;
      }
      s.need = null;
      s.activity = 'idle';
      return;
    }
    case 'sleep': {
      s.activity = 'sleeping';
      s.sleptInBed = !!n.bedId;
      const done = s.energy >= 99 || (!sleepWindow(state, s) && s.energy > 60) || s.thirst < 15 || s.hunger < 10;
      if (done) {
        // Step off the cot back onto the floor.
        s.x = Math.floor(n.target.x) + 0.5;
        s.y = Math.floor(n.target.y) + 0.5;
        s.need = null;
        s.activity = 'idle';
      }
      return;
    }
    case 'shelter': {
      s.activity = 'sheltering';
      const job = currentJob(state, s);
      if (!stormActive(state) || (job && !job.exposed)) {
        s.need = null;
        s.activity = 'idle';
      }
      return;
    }
  }
}

// ---------------------------------------------------------------- jobs

function jobValid(state: GameState, job: Job): boolean {
  if (job.kind === 'treat') {
    const p = getSurvivor(state, job.targetId);
    return !!p && p.alive;
  }
  const o = getObject(state, job.targetId);
  if (!o) return false;
  if (job.kind === 'build') return o.state === 'site';
  const a = findAction(o, job.actionId);
  return !!a && a.states.includes(o.state);
}

function abandon(state: GameState, s: Survivor, job: Job, why: string): void {
  releaseJob(state, job);
  if (job.phase !== 'haul') state.jobs = state.jobs.filter((j) => j.id !== job.id);
  if (!job.auto) log(state, `${job.label} abandoned: ${why}.`, 'warn');
  void s;
}

function runJob(state: GameState, s: Survivor, job: Job, occ: Uint8Array): void {
  if (job.phase !== 'haul' && !jobValid(state, job)) {
    abandon(state, s, job, 'the target changed');
    return;
  }
  if (job.phase === 'queued') {
    if (needsFetch(job)) {
      const why = jobWaitingOn(state, job);
      if (why) {
        job.blockedReason = why;
        releaseJob(state, job);
        return;
      }
      job.phase = 'fetch';
    } else {
      job.phase = 'travel';
    }
    job.blockedReason = null;
    s.goal = null;
  }
  if (job.phase === 'fetch') {
    const t = depotTile(state, occ, s);
    if (!t) return abandon(state, s, job, 'storage unreachable');
    s.activity = 'fetching';
    if (walkTo(state, s, occ, t) !== 'arrived') return;
    if (!stageInputs(state, job)) {
      job.blockedReason = jobWaitingOn(state, job) ?? 'Waiting for materials';
      releaseJob(state, job);
      return;
    }
    job.phase = 'travel';
    s.goal = null;
  }
  if (job.phase === 'travel') {
    s.activity = 'walking';
    let target: { x: number; y: number; w: number; h: number } | undefined;
    if (job.kind === 'treat') {
      const p = getSurvivor(state, job.targetId)!;
      if (p.away) return abandon(state, s, job, `${first(p)} left on an expedition`);
      target = { x: Math.floor(p.x), y: Math.floor(p.y), w: 1, h: 1 };
      if (Math.hypot(p.x - s.x, p.y - s.y) < 1.6) {
        job.phase = 'work';
        return;
      }
      // Patients move; walk toward their tile (or a neighbour if they're on a cot).
      const occTarget = walkable(occ, target.x, target.y) ? { x: target.x, y: target.y } : approachTile(occ, s, target);
      if (!occTarget) return;
      if (walkTo(state, s, occ, occTarget) === 'blocked') s.goal = null;
      return;
    }
    const o = getObject(state, job.targetId)!;
    const t = approachTile(occ, s, o);
    if (!t) return abandon(state, s, job, 'no way to reach it');
    const r = walkTo(state, s, occ, t);
    if (r === 'blocked') return abandon(state, s, job, 'no way to reach it');
    if (r !== 'arrived') return;
    s.facing = o.x + o.w / 2 - s.x - (o.y + o.h / 2 - s.y) >= 0 ? 1 : -1;
    job.phase = 'work';
  }
  if (job.phase === 'work') {
    if (job.kind === 'treat') {
      const p = getSurvivor(state, job.targetId)!;
      if (Math.hypot(p.x - s.x, p.y - s.y) > 2.2) {
        job.phase = 'travel';
        return;
      }
    }
    s.activity = 'working';
    job.progress += workRate(state, s, job);
    if (job.progress >= job.required) {
      completeJob(state, job, s);
      s.goal = null;
    }
    return;
  }
  if (job.phase === 'haul') {
    const t = depotTile(state, occ, s);
    s.activity = 'hauling';
    if (!t) {
      finishHaul(state, job, s);
      return;
    }
    if (walkTo(state, s, occ, t) !== 'arrived') return;
    finishHaul(state, job, s);
  }
}

/** Pick the most suitable open job for an idle survivor. */
export function pickJob(state: GameState, s: Survivor): Job | null {
  let best: Job | null = null;
  let bestScore = -Infinity;
  const storm = stormActive(state);
  for (const j of state.jobs) {
    if (j.assigneeId || j.phase !== 'queued') continue;
    if (j.preferredId && j.preferredId !== s.id) continue;
    if (!j.preferredId && !s.autoWork) continue;
    if (j.kind === 'treat' && j.targetId === s.id) continue;
    if (storm && j.exposed) continue;
    if (jobWaitingOn(state, j)) continue;
    // Leave skilled work to the specialist if they're free and fit.
    const rate = workRate(state, s, j);
    let score = rate * 10;
    if (j.preferredId === s.id) score += 100;
    if (j.auto) score += 4;
    if (j.kind === 'treat') score += 6;
    const o = getObject(state, j.targetId);
    if (o) score -= Math.hypot(o.x - s.x, o.y - s.y) * 0.08;
    score -= (state.minute - j.createdAt) * -0.001; // older jobs slightly first
    if (score > bestScore) {
      bestScore = score;
      best = j;
    }
  }
  return best;
}

function claim(state: GameState, s: Survivor, j: Job): void {
  j.assigneeId = s.id;
  j.blockedReason = null;
  s.jobId = j.id;
  s.goal = null;
  s.path = [];
  void state;
}

// ---------------------------------------------------------------- main tick

export function tickSurvivor(state: GameState, s: Survivor, occ: Uint8Array): void {
  if (!s.alive || s.away) return;
  updateNeeds(state, s);
  if (!s.alive) return;
  if (s.trapped) {
    s.activity = 'trapped';
    return;
  }
  if (s.quarantined) {
    runQuarantine(state, s, occ);
    return;
  }

  // If something was built on top of a survivor, step them aside.
  if (!walkable(occ, Math.floor(s.x), Math.floor(s.y)) && !(s.need?.kind === 'sleep' && s.need.arrived)) {
    const p = nearestWalkable(occ, s);
    s.x = p.x + 0.5;
    s.y = p.y + 0.5;
    s.path = [];
    s.goal = null;
  }

  if (!s.need) {
    const n = chooseNeed(state, s, occ);
    if (n) {
      s.need = n;
      s.goal = null;
      s.path = [];
    }
  }
  if (s.need) {
    runNeed(state, s, occ);
    return;
  }

  let job = currentJob(state, s);
  if (s.jobId && !job) s.jobId = null;
  if (!job && !s.moveTarget) {
    const pick = pickJob(state, s);
    if (pick) {
      claim(state, s, pick);
      job = pick;
    }
  }
  if (job) {
    if (stormActive(state) && job.exposed && job.phase !== 'haul') {
      // Outdoor work waits out the storm; the job stays with this worker.
      const t = shelterTile(state, occ, s);
      if (t && !isSheltered(s.x, s.y)) {
        s.need = { kind: 'shelter', target: t, arrived: false, timer: 0, bedId: null };
        runNeed(state, s, occ);
      } else {
        s.activity = 'sheltering';
      }
      return;
    }
    runJob(state, s, job, occ);
    return;
  }
  if (s.moveTarget) {
    s.activity = 'walking';
    const r = walkTo(state, s, occ, s.moveTarget);
    if (r !== 'moving') {
      s.moveTarget = null;
      s.activity = 'idle';
    }
    return;
  }
  s.activity = 'idle';
}

// ---------------------------------------------------------------- quarantine and contagion

function infirmaryBed(state: GameState, s: Survivor): WorldObject | null {
  const taken = new Set(state.survivors.filter((o) => o.alive && o.quarantined && o.id !== s.id && o.need?.bedId).map((o) => o.need!.bedId));
  const beds = state.objects.filter((o) => o.type === 'infirmary' && o.state === 'operational' && !taken.has(o.id));
  beds.sort((a, b) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y));
  return beds[0] ?? null;
}

/** Quarantined survivors stop working, rest in an isolation bed (or apart on the floor), and are brought food and water. */
function runQuarantine(state: GameState, s: Survivor, occ: Uint8Array): void {
  const job = currentJob(state, s);
  if (job) releaseJob(state, job);
  s.moveTarget = null;
  if (!s.need || s.need.kind !== 'sleep' || (!s.need.bedId && infirmaryBed(state, s))) {
    const bed = infirmaryBed(state, s);
    const t = bed ? approachTile(occ, s, bed) : floorSpot(state, occ, s);
    if (!t) {
      s.activity = 'idle';
      return;
    }
    s.need = { kind: 'sleep', target: t, arrived: false, timer: 0, bedId: bed?.id ?? null };
    s.goal = null;
    s.path = [];
  }
  const n = s.need;
  if (!n.arrived) {
    s.activity = 'walking';
    const r = walkTo(state, s, occ, n.target);
    if (r === 'blocked') s.need = null;
    if (r !== 'arrived') return;
    n.arrived = true;
    const bed = n.bedId ? getObject(state, n.bedId) : undefined;
    if (bed) {
      s.x = bed.x + 0.5;
      s.y = bed.y + 0.5;
    }
  }
  s.activity = 'sleeping';
  s.sleptInBed = !!n.bedId;
  // Food and water are brought to them.
  if (s.thirst < 40 && count(state, 'water') >= 0.5) s.thirst = Math.min(100, s.thirst + 30 * consumeUpTo(state, 'water', 1.5));
  if (s.hunger < 40 && count(state, 'food') >= 0.5) {
    consume(state, { food: 0.5 });
    s.hunger = Math.min(100, s.hunger + 45);
  }
}

export function endQuarantine(state: GameState, s: Survivor): void {
  s.quarantined = false;
  if (s.need?.kind === 'sleep' && s.need.arrived) {
    s.x = Math.floor(s.need.target.x) + 0.5;
    s.y = Math.floor(s.need.target.y) + 0.5;
  }
  s.need = null;
  s.activity = 'idle';
  void state;
}

/** Fever passes between people close together; the quarantined in isolation beds are sealed off. */
export function spreadIllness(state: GameState): void {
  const present = presentSurvivors(state);
  const carriers = present.filter((x) => x.illness?.kind === 'fever');
  if (!carriers.length) return;
  for (const c of carriers) {
    let factor = c.illness!.stage === 'sick' ? 1 : 0.25;
    if (c.quarantined) factor *= c.need?.bedId && c.need.arrived ? 0 : 0.15;
    if (factor <= 0) continue;
    for (const v of present) {
      if (v === c || v.illness || v.immune || v.trapped) continue;
      if (v.quarantined && v.need?.bedId) continue;
      const d = Math.hypot(v.x - c.x, v.y - c.y);
      if (d > 2.5) continue;
      if (chance(state, 0.0025 * factor * (d < 1.2 ? 1.5 : 1))) {
        v.illness = { kind: 'fever', stage: 'incubating', t: (14 + Math.floor(nextRandom(state) * 12)) * 60 };
      }
    }
  }
}
