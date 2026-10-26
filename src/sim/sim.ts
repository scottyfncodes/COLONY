import { blueprint, BLUEPRINTS, OBJECT_DEFS } from './actions';
import { log } from './inventory';
import { assignJob, cancelJob, getObject, getSurvivor, newId, queueAction, queueBuildJob, queueTreat } from './jobs';
import { autoJobs, tickCrops, tickPower, tickWater, tickWeather } from './infrastructure';
import { startExpedition, tickExpeditions } from './expeditions';
import { resolveEvent, runEvents } from './events';
import { evaluateEnd, updateObjectives } from './scenario';
import { createGame } from './setup';
import { aliveSurvivors, tickSurvivor } from './survivors';
import { END_MINUTE } from './time';
import { accessTiles, GATE_INSIDE, GATE_TILES, inCompound, occupancy, reachable, MAP_W, walkable } from './world';
import type { Command, CommandResult, GameState, ObjectType, WorldObject } from './types';

export function newGame(seed = Date.now() % 100000): GameState {
  const s = createGame(seed);
  runEvents(s);
  return s;
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
  autoJobs(state);
  const occ = occupancy(state);
  for (const s of state.survivors) tickSurvivor(state, s, occ);
  tickExpeditions(state);
  runEvents(state);
  if (state.minute % 10 === 0) updateObjectives(state);
  if (aliveSurvivors(state).length === 0) {
    state.result = evaluateEnd(state, true);
    log(state, 'The settlement is lost.', 'bad');
  } else if (state.minute >= END_MINUTE && !state.events.pending) {
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
  const occ = occupancy(state);
  for (let ty = y; ty < y + bp.h; ty++) {
    for (let tx = x; tx < x + bp.w; tx++) {
      if (!inCompound(tx, ty)) return 'Must be inside the fence.';
      if (!walkable(occ, tx, ty)) return 'Something is in the way.';
      if (GATE_TILES.some((g) => g.x === tx && g.y === ty)) return 'Keep the gate clear.';
      if (Math.abs(tx - GATE_INSIDE.x) <= 1 && Math.abs(ty - GATE_INSIDE.y) <= 1) return 'Keep the gate approach clear.';
    }
  }
  // Placing must not cut off any part of the compound.
  for (let ty = y; ty < y + bp.h; ty++) for (let tx = x; tx < x + bp.w; tx++) occ[ty * MAP_W + tx] = 2;
  const reach = reachable(occ, GATE_INSIDE);
  const site = { x, y, w: bp.w, h: bp.h };
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
    if (tx >= x && tx < x + bp.w && ty >= y && ty < y + bp.h) continue; // they'll step aside
    if (walkable(occ, tx, ty) && !reach[ty * MAP_W + tx]) return 'That would trap someone.';
  }
  return null;
}

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
  }
}

export { BLUEPRINTS };
