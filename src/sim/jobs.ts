import { actionsFor, blueprint, EMPTIES_CONTENTS, findAction, OBJECT_DEFS, objectName, type ActionDef } from './actions';
import { describeItems, isEmpty, missingItems } from './items';
import { consume, count, deposit, log, produce, take, transferAll } from './inventory';
import { chance } from './rng';
import { isSheltered, occupancy, accessTiles, nearestWalkable } from './world';
import { isNight } from './time';
import type { CommandResult, GameState, Items, Job, Survivor, WorldObject } from './types';

export function newId(state: GameState, prefix: string): string {
  return `${prefix}-${state.nextId++}`;
}

export function getObject(state: GameState, id: string): WorldObject | undefined {
  return state.objects.find((o) => o.id === id);
}

export function getSurvivor(state: GameState, id: string | null): Survivor | undefined {
  if (!id) return undefined;
  return state.survivors.find((s) => s.id === id);
}

export function jobsOn(state: GameState, targetId: string): Job[] {
  return state.jobs.filter((j) => j.targetId === targetId);
}

/** Why an action can't be queued on an object right now, or null if it can. Missing materials are OK — the job waits. */
export function actionBlocked(state: GameState, o: WorldObject, a: ActionDef): string | null {
  if (!a.states.includes(o.state)) return 'Not possible in this state';
  if (a.visible && !a.visible(state, o)) return 'Not needed';
  const existing = jobsOn(state, o.id);
  if (existing.length) return `Already queued: ${existing[0].label}`;
  if (a.blocked) return a.blocked(state, o);
  return null;
}

export function availableActions(state: GameState, o: WorldObject): ActionDef[] {
  return actionsFor(o).filter((a) => a.states.includes(o.state) && (!a.visible || a.visible(state, o)));
}

function exposedTarget(o: WorldObject): boolean {
  return !isSheltered(o.x, o.y);
}

export function queueAction(state: GameState, objectId: string, actionId: string, assigneeId: string | null = null): CommandResult {
  const o = getObject(state, objectId);
  if (!o) return { ok: false, message: 'Nothing there.' };
  const a = findAction(o, actionId);
  if (!a) return { ok: false, message: 'Unknown action.' };
  const why = actionBlocked(state, o, a);
  if (why) return { ok: false, message: why };
  const job: Job = {
    id: newId(state, 'j'),
    kind: a.kind,
    actionId: a.id,
    targetId: o.id,
    label: `${a.label} · ${objectName(o)}`,
    assigneeId: null,
    preferredId: null,
    phase: 'queued',
    progress: 0,
    required: a.minutes,
    inputs: { ...a.inputs(state, o) },
    needsTools: a.tools,
    staged: {},
    skill: a.skill,
    auto: false,
    createdAt: state.minute,
    blockedReason: null,
    exposed: exposedTarget(o),
  };
  state.jobs.push(job);
  if (assigneeId) assignJob(state, job.id, assigneeId);
  return { ok: true, message: `Queued: ${job.label}` };
}

export function queueBuildJob(state: GameState, site: WorldObject, assigneeId: string | null): Job {
  const bp = blueprint(site.label as WorldObject['type'])!;
  const job: Job = {
    id: newId(state, 'j'),
    kind: 'build',
    actionId: 'build',
    targetId: site.id,
    label: `Build · ${bp.name}`,
    assigneeId: null,
    preferredId: null,
    phase: 'queued',
    progress: 0,
    required: bp.minutes,
    inputs: { ...bp.inputs },
    needsTools: bp.needsTools,
    staged: {},
    skill: 'construction',
    auto: false,
    createdAt: state.minute,
    blockedReason: null,
    exposed: exposedTarget(site),
  };
  state.jobs.push(job);
  if (assigneeId) assignJob(state, job.id, assigneeId);
  return job;
}

export function queueTreat(state: GameState, patientId: string, assigneeId: string | null, auto = false): CommandResult {
  const p = getSurvivor(state, patientId);
  if (!p || !p.alive) return { ok: false, message: 'No patient.' };
  if (p.away) return { ok: false, message: `${p.name} is away.` };
  if (state.jobs.some((j) => j.kind === 'treat' && j.targetId === patientId)) return { ok: false, message: 'Treatment already queued.' };
  if (p.injury < 1 && p.sick <= 0 && p.health > 80) return { ok: false, message: `${p.name} doesn't need treatment.` };
  const job: Job = {
    id: newId(state, 'j'),
    kind: 'treat',
    actionId: 'treat',
    targetId: patientId,
    label: `Treat · ${p.name.split(' ')[0]}`,
    assigneeId: null,
    preferredId: null,
    phase: 'queued',
    progress: 0,
    required: 60,
    inputs: { meds: 1 },
    needsTools: false,
    staged: {},
    skill: 'medical',
    auto,
    createdAt: state.minute,
    blockedReason: null,
    exposed: false,
  };
  state.jobs.push(job);
  if (assigneeId) assignJob(state, job.id, assigneeId);
  return { ok: true, message: `Queued: ${job.label}` };
}

/** Return any staged materials to storage and detach the worker. The job goes back on the board. */
export function releaseJob(state: GameState, job: Job): void {
  const w = getSurvivor(state, job.assigneeId);
  if (w && w.jobId === job.id) {
    w.jobId = null;
    w.path = [];
    if (w.activity !== 'dead' && w.activity !== 'away') w.activity = 'idle';
  }
  job.assigneeId = null;
  if (job.phase === 'haul') {
    // Outputs already exist; drop them into storage rather than lose them.
    finishHaul(state, job);
    return;
  }
  if (!isEmpty(job.staged)) {
    deposit(state, job.staged);
    if (!isEmpty(job.staged)) spillToCrate(state, job.staged);
  }
  job.phase = 'queued';
}

export function cancelJob(state: GameState, jobId: string): CommandResult {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return { ok: false, message: 'No such job.' };
  if (job.phase === 'haul') return { ok: false, message: 'Already finished — goods are on their way to storage.' };
  releaseJob(state, job);
  state.jobs = state.jobs.filter((j) => j.id !== jobId);
  // Cancelling a build removes its empty site.
  const site = getObject(state, job.targetId);
  if (job.kind === 'build' && site && site.state === 'site') state.objects = state.objects.filter((o) => o.id !== site.id);
  return { ok: true, message: `Cancelled: ${job.label}` };
}

export function assignJob(state: GameState, jobId: string, survivorId: string | null): CommandResult {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return { ok: false, message: 'No such job.' };
  if (job.phase === 'haul') return { ok: false, message: 'Job is finishing.' };
  if (!survivorId) {
    if (job.assigneeId) releaseJob(state, job);
    job.preferredId = null;
    return { ok: true, message: 'Anyone available will take it.' };
  }
  const s = getSurvivor(state, survivorId);
  if (!s || !s.alive) return { ok: false, message: 'Nobody to assign.' };
  if (s.away) return { ok: false, message: `${s.name} is on an expedition.` };
  if (job.kind === 'treat' && job.targetId === s.id) return { ok: false, message: 'Nobody can treat themselves properly.' };
  if (s.jobId && s.jobId !== job.id) {
    const cur = state.jobs.find((j) => j.id === s.jobId);
    if (cur) {
      if (cur.phase === 'haul') return { ok: false, message: `${s.name} is hauling goods — try again in a moment.` };
      releaseJob(state, cur);
      cur.preferredId = null;
    }
  }
  if (job.assigneeId && job.assigneeId !== s.id) releaseJob(state, job);
  job.preferredId = s.id;
  job.assigneeId = s.id;
  job.blockedReason = null;
  job.phase = 'queued';
  s.jobId = job.id;
  s.moveTarget = null;
  s.path = [];
  return { ok: true, message: `${s.name.split(' ')[0]} → ${job.label}` };
}

export function toolsAvailable(state: GameState): number {
  return count(state, 'tools');
}

/** Can this job start its fetch right now? Returns a human-readable reason if not. */
export function jobWaitingOn(state: GameState, job: Job): string | null {
  if (job.phase !== 'queued') return null;
  const need: Items = { ...job.inputs };
  const missing = missingItems(state.inventory, need);
  const parts: string[] = [];
  if (!isEmpty(missing)) parts.push(describeItems(missing));
  if (job.needsTools && toolsAvailable(state) < 1) parts.push('a free tool kit');
  if (job.kind === 'treat') {
    const p = getSurvivor(state, job.targetId);
    if (!p || p.away) parts.push('the patient');
  }
  return parts.length ? `Needs ${parts.join(' + ')}` : null;
}

export function needsFetch(job: Job): boolean {
  return !isEmpty(job.inputs) || job.needsTools;
}

/** Try to take the job's inputs (and a tool kit) from storage into the worker's hands. */
export function stageInputs(state: GameState, job: Job): boolean {
  const need: Items = { ...job.inputs };
  if (job.needsTools) need.tools = (need.tools ?? 0) + 1;
  return take(state, need, job.staged);
}

export function workRate(state: GameState, s: Survivor, job: Job): number {
  const lvl = job.skill ? s.skills[job.skill] : 1.5;
  let r = job.skill ? 0.45 + 0.35 * lvl : 1;
  if (s.trait === 'steady' && (job.kind === 'repair' || job.kind === 'service')) r *= 1.2;
  if (s.health < 50) r *= 0.7;
  if (s.injury > 40) r *= 0.7;
  if (s.sick > 0) r *= 0.75;
  if (s.energy < 25) r *= 0.75;
  if (s.morale < 25) r *= 0.85;
  else if (s.morale > 75) r *= 1.1;
  if (isNight(state.minute) && s.trait !== 'nightOwl' && job.exposed && !litNear(state, s.x, s.y)) r *= 0.75;
  if (job.kind === 'craft') {
    const bench = getObject(state, job.targetId);
    if (bench && bench.type === 'workbench' && !bench.powered) r *= 0.6;
  }
  return r;
}

export function litNear(state: GameState, x: number, y: number): boolean {
  return state.objects.some((o) => o.type === 'lamp' && o.state === 'operational' && o.powered && Math.hypot(o.x + 0.5 - x, o.y + 0.5 - y) < 6);
}

/** Apply the job's effect, consume inputs, and stage outputs for hauling. */
export function completeJob(state: GameState, job: Job, worker: Survivor): void {
  const inputs: Items = { ...job.inputs };
  if (!isEmpty(inputs)) consume(state, inputs, job.staged);
  let outputs: Items = {};
  if (job.kind === 'treat') {
    const p = getSurvivor(state, job.targetId);
    if (p && p.alive) {
      const skill = worker.skills.medical;
      p.injury = Math.max(0, p.injury - (skill >= 3 ? 100 : 50));
      p.sick = skill >= 3 ? 0 : Math.max(0, p.sick - 12 * 60);
      p.health = Math.min(100, p.health + (skill >= 3 ? 25 : 12));
      p.morale = Math.min(100, p.morale + 5);
      log(state, `${worker.name.split(' ')[0]} treated ${p.name.split(' ')[0]}.`, 'good');
    }
  } else if (job.kind === 'build') {
    const site = getObject(state, job.targetId);
    const bp = site && blueprint(site.label as WorldObject['type']);
    if (site && bp) {
      site.type = bp.type;
      site.state = bp.initialState;
      site.on = true;
      site.label = undefined;
      site.data = bp.type === 'planter' ? { growth: 0, moisture: 0 } : {};
      state.stats.built++;
      log(state, `${bp.name} built.`, 'good');
    }
  } else {
    const o = getObject(state, job.targetId);
    const a = o && findAction(o, job.actionId);
    if (o && a) {
      outputs = a.outputs ? { ...a.outputs(state, o) } : {};
      if (EMPTIES_CONTENTS.has(a.id)) {
        // Contents move from the object into the worker's hands: a transfer, not production.
        transferAll(o.contents, job.staged);
        outputs = {};
      }
      if (job.kind === 'dismantle' && worker.trait === 'tinkerer') {
        if (outputs.mech) outputs.mech += 1;
        else if (outputs.elec) outputs.elec += 1;
      }
      a.effect(state, o);
    }
  }
  if (!isEmpty(outputs)) produce(state, outputs, job.staged);
  // Unskilled hands on machinery occasionally get hurt.
  if (job.skill && (job.kind === 'dismantle' || job.kind === 'repair') && worker.skills[job.skill] === 0) {
    if (chance(state, worker.trait === 'tough' ? 0.04 : 0.08)) {
      worker.injury = Math.min(100, worker.injury + 25);
      worker.health = Math.max(1, worker.health - 10);
      log(state, `${worker.name.split(' ')[0]} gashed a hand on unfamiliar machinery.`, 'bad');
    }
  }
  worker.workedMinutes += job.required;
  if (isEmpty(job.staged)) {
    removeJob(state, job, worker);
  } else {
    job.phase = 'haul';
  }
}

export function finishHaul(state: GameState, job: Job, worker?: Survivor): void {
  deposit(state, job.staged);
  if (!isEmpty(job.staged)) {
    const solids = { ...job.staged };
    delete solids.water;
    delete solids.rawWater;
    if (!isEmpty(solids)) log(state, `Storage full — ${describeItems(solids)} left in an overflow crate.`, 'warn');
    spillToCrate(state, job.staged);
  }
  removeJob(state, job, worker ?? getSurvivor(state, job.assigneeId));
}

function removeJob(state: GameState, job: Job, worker?: Survivor): void {
  state.jobs = state.jobs.filter((j) => j.id !== job.id);
  if (worker && worker.jobId === job.id) {
    worker.jobId = null;
    worker.path = [];
    if (worker.activity !== 'dead' && worker.activity !== 'away') worker.activity = 'idle';
  }
}

/** Put loose items into an overflow crate beside the depot so nothing is ever silently destroyed. */
export function spillToCrate(state: GameState, items: Items): void {
  // Liquids that don't fit are poured away (recorded as consumed); solids go in a crate.
  for (const k of ['water', 'rawWater'] as const) {
    if ((items[k] ?? 0) > 0) consume(state, { [k]: items[k] }, items);
  }
  if (isEmpty(items)) return;
  let crate = state.objects.find((o) => o.type === 'crate' && o.state === 'pile' && !jobsOn(state, o.id).some((j) => j.phase !== 'queued'));
  if (!crate) {
    const occ = occupancy(state);
    const depot = getObject(state, 'depot')!;
    const spot = accessTiles(occ, depot).find((p) => p.x !== depot.x - 1) ?? nearestWalkable(occ, { x: depot.x + 3, y: depot.y + 3 });
    crate = {
      id: newId(state, 'o-crate'),
      type: 'crate',
      x: spot.x,
      y: spot.y,
      w: 1,
      h: 1,
      state: 'pile',
      condition: 100,
      reinforced: false,
      on: false,
      powered: false,
      data: {},
      contents: {},
      issues: [],
    };
    state.objects.push(crate);
  }
  transferAll(items, crate.contents);
}

export function describeAction(state: GameState, o: WorldObject, a: ActionDef): {
  inputs: Items;
  missing: Items;
  outputs: Items;
  tools: boolean;
  minutes: number;
} {
  const inputs = a.inputs(state, o);
  const outputs = a.outputs ? a.outputs(state, o) : {};
  return { inputs, missing: missingItems(state.inventory, inputs), outputs, tools: a.tools, minutes: a.minutes };
}

export function objectStatusLine(o: WorldObject): string {
  return `${OBJECT_DEFS[o.type].name} — ${o.state}`;
}

