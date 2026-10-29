import { blueprint, BLUEPRINTS, OBJECT_DEFS } from './actions';
import { log } from './inventory';
import { assignJob, cancelJob, getObject, getSurvivor, newId, queueAction, queueBuildJob, queueTreat } from './jobs';
import { autoJobs, tickCrops, tickPower, tickWater, tickWeather } from './infrastructure';
import { startExpedition, tickExpeditions } from './expeditions';
import { resolveEvent, runEvents } from './events';
import { evaluateEnd, updateObjectives } from './scenario';
import { createGame } from './setup';
import { applyScenario, CATASTROPHE_IDS, isActive, setPlacementCheck, tickWorld, type NewGameOptions } from './catastrophes';
import { tickDirector } from './director';
import { runSandbox } from './sandbox';
import { tickSocial } from './social';
import { hashNoise } from './rng';
import { aliveSurvivors, endQuarantine, spreadIllness, tickSurvivor } from './survivors';
import { END_MINUTE, dayOf } from './time';
import { accessTiles, GATE_INSIDE, GATE_TILES, inCompound, isSheltered, occupancy, reachable, MAP_W, walkable, ZONES } from './world';
import type { Command, CommandResult, GameState, ObjectType, WorldObject } from './types';

export function newGame(seed = Date.now() % 100000, opts?: Partial<NewGameOptions>): GameState {
  const s = createGame(seed);
  const o: NewGameOptions = { catastrophe: 'storm', difficulty: 'normal', mode: 'survival', ...opts };
  if (o.random) {
    // Random scenario: any catastrophe, chosen from the seed.
    o.catastrophe = CATASTROPHE_IDS[Math.floor(hashNoise(seed, 97) * CATASTROPHE_IDS.length)];
  }
  applyScenario(s, o);
  shuffleLayout(s);
  runEvents(s);
  return s;
}

/** Loose heaps and wrecks that move between games; machines and buildings stay put. */
const LOOSE: ObjectType[] = ['scrapPile', 'wreckedCar'];

/**
 * Each new game scatters the salvage differently and shuffles what each heap holds, so no two
 * runs open the same way. Uses its own hash stream so the game's RNG sequence is untouched.
 */
export function shuffleLayout(state: GameState): void {
  let n = 0;
  const rnd = () => hashNoise(state.seed, 7000 + n++);
  const loose = state.objects.filter((o) => LOOSE.includes(o.type) && o.state !== 'dismantled');
  const contents = loose.filter((o) => o.type === 'scrapPile').map((o) => o.contents);
  for (let i = contents.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [contents[i], contents[j]] = [contents[j], contents[i]];
  }
  loose.filter((o) => o.type === 'scrapPile').forEach((o, i) => (o.contents = contents[i]));
  for (const o of loose) {
    const home = { x: o.x, y: o.y };
    state.objects.splice(state.objects.indexOf(o), 1);
    let placed = false;
    for (let tries = 0; tries < 60 && !placed; tries++) {
      const x = 3 + Math.floor(rnd() * (MAP_W - 6 - o.w));
      const y = 3 + Math.floor(rnd() * 25);
      if (isSheltered(x, y) || isSheltered(x + o.w - 1, y) || inZone(x, y, o.w, o.h)) continue;
      if (footprintBlocked(state, o.w, o.h, x, y)) continue;
      o.x = x;
      o.y = y;
      placed = true;
    }
    if (!placed) Object.assign(o, home);
    state.objects.push(o);
  }
}

function inZone(x: number, y: number, w: number, h: number): boolean {
  return ZONES.some((z) => x + w - 1 >= z.x0 - 1 && x <= z.x1 + 1 && y + h - 1 >= z.y0 - 1 && y <= z.y1 + 1);
}

/** After Day 7: keep the settlement going with harder seasons until everyone is gone or the player settles. */
export function continueEndless(state: GameState): CommandResult {
  if (!state.result || state.result.status !== 'won' || state.flags.endless) return { ok: false, message: 'Only a surviving settlement can keep going.' };
  state.flags.endless = true;
  state.flags.endlessGrade = state.result.grade;
  state.result = null;
  // The weather keeps turning: a rain spell every two to three days.
  let t = state.minute + 20 * 60;
  for (let k = 0; k < 40; k++) {
    const len = (4 + Math.floor(hashNoise(state.seed, 900 + k) * 5)) * 60;
    state.weather.rainWindows.push({ start: t, end: t + len, heavy: hashNoise(state.seed, 950 + k) < 0.25 ? 1 : undefined });
    t += (44 + Math.floor(hashNoise(state.seed, 980 + k) * 30)) * 60;
  }
  log(state, 'The week is over, but the world hasn’t ended. Every day from here is harder.', 'warn');
  return { ok: true, message: 'The settlement endures.' };
}

/** End an endless run on the player's terms. */
export function settleDown(state: GameState): CommandResult {
  if (!state.flags.endless || state.result) return { ok: false, message: 'Nothing to settle.' };
  updateObjectives(state);
  state.result = evaluateEnd(state);
  log(state, `The settlement stands after ${dayOf(state.minute)} days.`, 'good');
  return { ok: true, message: '' };
}

export function isPaused(state: GameState): boolean {
  return !!state.events.pending || !!state.result;
}

/** Advance the simulation by exactly one game minute. */
export function step(state: GameState): void {
  if (isPaused(state)) return;
  state.minute++;
  tickWeather(state);
  tickPower(state);
  tickWater(state);
  tickCrops(state);
  tickWorld(state);
  autoJobs(state);
  const occ = occupancy(state);
  for (const s of state.survivors) tickSurvivor(state, s, occ);
  spreadIllness(state);
  tickExpeditions(state);
  runEvents(state);
  if (!state.events.pending) tickDirector(state);
  if (state.minute % 60 === 0) tickSocial(state);
  if (state.minute % 10 === 0) updateObjectives(state);
  if (aliveSurvivors(state).length === 0) {
    state.result = evaluateEnd(state, true);
    log(state, 'The settlement is lost.', 'bad');
  } else if (state.minute >= END_MINUTE && !state.events.pending && !state.flags.endless) {
    updateObjectives(state);
    state.result = evaluateEnd(state);
    log(state, `Seven days survived: ${state.result.grade}.`, state.result.status === 'won' ? 'good' : 'bad');
  }
}

export function advance(state: GameState, minutes: number): void {
  for (let i = 0; i < minutes && !isPaused(state); i++) step(state);
}

export function validatePlacement(state: GameState, type: ObjectType, x: number, y: number): string | null {
  const bp = blueprint(type);
  if (!bp) return 'Unknown blueprint.';
  if (bp.scenarios && !blueprintAvailable(state, type)) return 'Not needed in this scenario.';
  if (bp.zone) {
    const why = bp.zone(x, y);
    if (why) return why;
  }
  return footprintBlocked(state, bp.w, bp.h, x, y);
}

export function blueprintAvailable(state: GameState, type: ObjectType): boolean {
  const bp = blueprint(type);
  if (!bp) return false;
  if (!bp.scenarios) return true;
  return bp.scenarios.some((c) => isActive(state, c)) || (state.world.mode === 'sandbox' && state.world.extra.length > 0 && bp.scenarios.some((c) => state.world.extra.includes(c)));
}

/** Can a w×h footprint go here without blocking anything? Returns a reason or null. */
export function footprintBlocked(state: GameState, w: number, h: number, x: number, y: number): string | null {
  const occ = occupancy(state);
  for (let ty = y; ty < y + h; ty++) {
    for (let tx = x; tx < x + w; tx++) {
      if (!inCompound(tx, ty)) return 'Must be inside the fence.';
      if (!walkable(occ, tx, ty)) return 'Something is in the way.';
      if (GATE_TILES.some((g) => g.x === tx && g.y === ty)) return 'Keep the gate clear.';
      if (Math.abs(tx - GATE_INSIDE.x) <= 1 && Math.abs(ty - GATE_INSIDE.y) <= 1) return 'Keep the gate approach clear.';
    }
  }
  // Placing must not cut off any part of the compound.
  for (let ty = y; ty < y + h; ty++) for (let tx = x; tx < x + w; tx++) occ[ty * MAP_W + tx] = 2;
  const reach = reachable(occ, GATE_INSIDE);
  const site = { x, y, w, h };
  if (!accessTiles(occ, site).some((p) => reach[p.y * MAP_W + p.x])) return 'Nobody could reach it there.';
  for (const o of state.objects) {
    if (o.state === 'dismantled' || o.type === 'gate' || o.type === 'shelf' || o.type === 'table') continue;
    const tiles = accessTiles(occ, o);
    if (tiles.length && !tiles.some((p) => reach[p.y * MAP_W + p.x])) return `That would block access to the ${OBJECT_DEFS[o.type].name.toLowerCase()}.`;
  }
  for (const s of state.survivors) {
    if (!s.alive || s.away) continue;
    const tx = Math.floor(s.x);
    const ty = Math.floor(s.y);
    if (tx >= x && tx < x + w && ty >= y && ty < y + h) continue; // they'll step aside
    if (walkable(occ, tx, ty) && !reach[ty * MAP_W + tx]) return 'That would trap someone.';
  }
  return null;
}

setPlacementCheck((s, w, h, x, y) => footprintBlocked(s, w, h, x, y) === null);

function placeSite(state: GameState, type: ObjectType, x: number, y: number): WorldObject {
  const bp = blueprint(type)!;
  const site: WorldObject = {
    id: newId(state, `o-${type}`),
    type,
    x,
    y,
    w: bp.w,
    h: bp.h,
    state: 'site',
    condition: 100,
    reinforced: false,
    on: false,
    powered: false,
    data: {},
    contents: {},
    issues: [],
    label: type,
  };
  state.objects.push(site);
  return site;
}

const TOGGLEABLE: ObjectType[] = ['generator', 'waterPump', 'purifier', 'sandFilter', 'lamp', 'radio', 'windTurbine', 'workbench'];

export function canToggle(o: WorldObject): boolean {
  return TOGGLEABLE.includes(o.type) && o.state === 'operational';
}

export function dispatch(state: GameState, cmd: Command): CommandResult {
  if (state.result) return { ok: false, message: 'The scenario is over.' };
  if (state.events.pending && cmd.type !== 'choose') return { ok: false, message: 'Decide first.' };
  switch (cmd.type) {
    case 'queueAction':
      return queueAction(state, cmd.objectId, cmd.actionId, cmd.assigneeId ?? null);
    case 'treat':
      return queueTreat(state, cmd.patientId, cmd.assigneeId ?? null);
    case 'cancelJob':
      return cancelJob(state, cmd.jobId);
    case 'assignJob':
      return assignJob(state, cmd.jobId, cmd.survivorId);
    case 'move': {
      const s = getSurvivor(state, cmd.survivorId);
      if (!s || !s.alive || s.away) return { ok: false, message: 'Cannot move them.' };
      const occ = occupancy(state);
      if (!walkable(occ, cmd.x, cmd.y)) return { ok: false, message: 'Cannot walk there.' };
      const job = state.jobs.find((j) => j.id === s.jobId);
      if (job) {
        if (job.phase === 'haul') return { ok: false, message: `${s.name.split(' ')[0]} is hauling goods.` };
        assignJob(state, job.id, null);
      }
      s.need = null;
      s.moveTarget = { x: cmd.x, y: cmd.y };
      s.goal = null;
      s.path = [];
      return { ok: true, message: `${s.name.split(' ')[0]} is on the way.` };
    }
    case 'build': {
      const why = validatePlacement(state, cmd.blueprint, cmd.x, cmd.y);
      if (why) return { ok: false, message: why };
      const site = placeSite(state, cmd.blueprint, cmd.x, cmd.y);
      queueBuildJob(state, site, cmd.assigneeId ?? null);
      return { ok: true, message: `${blueprint(cmd.blueprint)!.name} site marked.` };
    }
    case 'toggle': {
      const o = getObject(state, cmd.objectId);
      if (!o || !canToggle(o)) return { ok: false, message: 'Cannot switch that.' };
      o.on = !o.on;
      if (o.type === 'generator' && !o.on) o.data.running = 0;
      return { ok: true, message: `${OBJECT_DEFS[o.type].name} switched ${o.on ? 'on' : 'off'}.` };
    }
    case 'setAutoWork': {
      const s = getSurvivor(state, cmd.survivorId);
      if (!s) return { ok: false, message: 'No such survivor.' };
      s.autoWork = cmd.value;
      return { ok: true, message: `${s.name.split(' ')[0]} ${cmd.value ? 'will pick up open jobs' : 'waits for orders'}.` };
    }
    case 'expedition':
      return startExpedition(state, cmd.destination, cmd.members, cmd.packed, cmd.vehicle);
    case 'choose':
      return resolveEvent(state, cmd.choiceId);
    case 'quarantine': {
      const s = getSurvivor(state, cmd.survivorId);
      if (!s || !s.alive) return { ok: false, message: 'Nobody to isolate.' };
      if (s.away) return { ok: false, message: `${s.name} is away.` };
      if (s.trapped) return { ok: false, message: `${s.name} is trapped.` };
      if (cmd.value === s.quarantined) return { ok: true, message: '' };
      if (cmd.value) {
        s.quarantined = true;
        const job = state.jobs.find((j) => j.id === s.jobId);
        if (job) assignJob(state, job.id, null);
        s.need = null;
        return { ok: true, message: `${s.name.split(' ')[0]} is going into quarantine.` };
      }
      endQuarantine(state, s);
      return { ok: true, message: `${s.name.split(' ')[0]} is back on their feet.` };
    }
    case 'sandbox':
      return runSandbox(state, cmd.action);
  }
}

export { BLUEPRINTS };
