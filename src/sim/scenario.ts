import { OBJECT_DEFS } from './actions';
import { count } from './inventory';
import { CATASTROPHES, defense, difficultyInfo, isActive, radiationNow } from './catastrophes';
import { aliveSurvivors } from './survivors';
import { END_MINUTE, dayOf, formatDuration } from './time';
import type { GameState, ScenarioResult } from './types';

export interface Objective {
  id: string;
  label: string;
  detail: string;
  optional: boolean;
  done: boolean;
  progress: string;
}

function op(s: GameState, type: string) {
  return s.objects.filter((o) => o.type === type && o.state === 'operational');
}

export function systemStatus(s: GameState) {
  const gen = s.objects.find((o) => o.type === 'generator');
  const genOk = !!gen && gen.state === 'operational' && gen.on;
  const turbine = op(s, 'windTurbine').length > 0;
  const power = (genOk && (count(s, 'fuel') >= 2 || s.power.stored > 8)) || turbine;
  const source = op(s, 'waterPump').length > 0 || op(s, 'rainCatcher').length > 0;
  const treatment = op(s, 'sandFilter').length > 0 || op(s, 'purifier').length > 0;
  const water = source && treatment;
  const beds = s.objects.filter((o) => o.type === 'planter' && (o.state === 'growing' || o.state === 'ready')).length;
  const food = beds >= 2;
  return { power, water, food, genOk, turbine, source, treatment, beds };
}

export function objectives(s: GameState): Objective[] {
  const def = CATASTROPHES[s.world.catastrophe];
  const c = s.world.climax;
  const alive = aliveSurvivors(s).length;
  const total = s.survivors.length;
  const sys = systemStatus(s);
  const beds = sys.beds;
  const list: Objective[] = [
    {
      id: 'alive',
      label: 'Keep everyone alive',
      detail: 'Nobody dies before the end of Day 7.',
      optional: false,
      done: s.stats.deaths.length === 0,
      progress: `${alive}/${total} alive`,
    },
    {
      id: 'power',
      label: 'Establish reliable power',
      detail: 'Keep powered equipment running for 12 hours.',
      optional: false,
      done: !!s.objectivesDone.power,
      progress: `${Math.min(12, s.stats.powerHours).toFixed(1)}/12 h powered`,
    },
    {
      id: 'water',
      label: 'Establish safe water',
      detail: 'Treat 40 L of water at the compound.',
      optional: false,
      done: !!s.objectivesDone.water,
      progress: `${Math.min(40, s.stats.cleanWaterMade).toFixed(0)}/40 L treated`,
    },
    {
      id: 'food',
      label: 'Grow a food supply',
      detail: 'Have 3 planters growing at once, or harvest 10 rations.',
      optional: false,
      done: !!s.objectivesDone.food,
      progress: `${beds}/3 growing · ${s.stats.foodGrown} harvested`,
    },
    {
      id: 'storm',
      label: def.climax.objective,
      detail: def.climax.detail,
      optional: false,
      done: !!s.objectivesDone.storm,
      progress: c.resolved ? `${s.stats.stormDamage.length} damage reports` : c.known ? `in ${formatDuration(c.at - s.minute)}` : 'coming…',
    },
    ...(def.objective
      ? [{ id: def.objective.id, label: def.objective.label, detail: def.objective.detail, optional: false, done: s.minute >= END_MINUTE || !!s.result ? def.objective.done(s) : !!s.objectivesDone[def.objective.id] || def.objective.done(s), progress: def.objective.progress(s) }]
      : []),
    {
      id: 'day7',
      label: 'Reach the end of Day 7',
      detail: 'With a functioning settlement.',
      optional: false,
      done: s.minute >= END_MINUTE,
      progress: `Day ${Math.min(7, dayOf(s.minute))} of 7`,
    },
    {
      id: 'engineer',
      label: 'Improvised engineering',
      detail: 'Fit the forklift’s engine into the generator.',
      optional: true,
      done: !!s.objects.find((o) => o.type === 'generator' && o.data.efficient),
      progress: '',
    },
    {
      id: 'neighbours',
      label: 'Good neighbours',
      detail: 'Earn the Kesslers’ trust.',
      optional: true,
      done: s.trust.kessler >= 25,
      progress: `trust ${s.trust.kessler}`,
    },
    {
      id: 'braced',
      label: 'Nothing left to chance',
      detail: 'Suffer no storm damage at all.',
      optional: true,
      done: s.weather.stormResolved && s.stats.stormDamage.length === 0,
      progress: '',
    },
    {
      id: 'lights',
      label: 'Lights in the dark',
      detail: 'Have 2 work lamps running.',
      optional: true,
      done: op(s, 'lamp').length >= 2,
      progress: `${op(s, 'lamp').length}/2`,
    },
  ];
  return list;
}

/** Latch objectives that are met once (power hours etc.). */
export function updateObjectives(s: GameState): void {
  const done = s.objectivesDone;
  if (!done.power && s.stats.powerHours >= 12) done.power = s.minute;
  if (!done.water && s.stats.cleanWaterMade >= 40) done.water = s.minute;
  const beds = s.objects.filter((o) => o.type === 'planter' && (o.state === 'growing' || o.state === 'ready')).length;
  if (!done.food && (beds >= 3 || s.stats.foodGrown >= 10)) done.food = s.minute;
  if (!done.storm && s.world.climax.resolved) {
    const c = s.world.climax;
    const stormDeaths = s.stats.deaths.filter((d) => d.minute >= c.at && d.minute <= Math.max(c.end, s.minute)).length;
    if (stormDeaths === 0 && s.stats.stormDamage.length <= 3) done.storm = s.minute;
  }
}

/** Short, non-prescriptive pointer to what needs attention most. */
export function immediateObjective(s: GameState): string {
  const sys = systemStatus(s);
  const gen = s.objects.find((o) => o.type === 'generator');
  const hoursToStorm = (s.weather.stormStart - s.minute) / 60;
  if (s.weather.kind === 'storm') return 'Ride out the storm. Outdoor work is impossible.';
  const trapped = s.survivors.find((x) => x.alive && x.trapped);
  if (trapped) return `Dig ${trapped.name.split(' ')[0]} out of the rubble before it’s too late.`;
  if (s.objects.some((o) => o.data.burning)) return 'Fire! Douse it with water before it burns out.';
  const spreading = s.survivors.some((x) => x.alive && !x.away && x.illness?.kind === 'fever' && x.illness.stage === 'sick' && !x.quarantined);
  if (spreading) return 'The fever is spreading. Isolate the sick and treat them.';
  const bitten = s.survivors.find((x) => x.alive && x.illness?.kind === 'bite');
  if (bitten) return `${bitten.name.split(' ')[0]} is bitten. Treat the wound (2 meds) before it turns.`;
  if (radiationNow(s) > 4) return 'Radiation is high outside. Keep outdoor work short and filter your water.';
  if (isActive(s, 'outbreak') && s.world.horde > defense(s).value * 6) return 'The infected are massing. Cut the noise or strengthen the fence.';
  if (isActive(s, 'collapse') && s.world.threat >= 50) return 'The Ridge Crew are getting bolder. Secure the gate and build barricades.';
  if (isActive(s, 'quake') && s.world.climax.known && !s.world.climax.resolved && s.objects.filter((o) => o.type === 'levee').length < 2)
    return 'The flood is coming. Stack sandbag levees on the low ground.';
  if (s.weather.stormResolved && s.stats.stormDamage.length && s.objects.some((o) => ['flooded', 'broken'].includes(o.state) && ['generator', 'waterPump'].includes(o.type)))
    return 'Repair what the storm broke.';
  if (count(s, 'water') < 10 && !sys.treatment) {
    if (count(s, 'rawWater') >= 8) return 'Low on safe water: boil untreated water at the mess table, or build a sand filter.';
    return 'Low on safe water: draw water from the well by hand, then boil or filter it.';
  }
  if (gen && gen.state !== 'operational' && gen.state !== 'dismantled') return 'Get the generator running — power unlocks the well.';
  if (!sys.source) return 'Get water flowing from a source.';
  if (!sys.treatment) return 'Untreated water makes people sick. Set up treatment.';
  if (count(s, 'food') < 6 && sys.beds < 2) return 'Food is short. Scavenge it or grow it.';
  if (sys.beds < 3 && !s.objectivesDone.food) return 'Build up the growing plot.';
  if (hoursToStorm < 48 && hoursToStorm > 0) return 'The storm is close. Brace exposed equipment.';
  if (count(s, 'fuel') < 3 && !sys.turbine) return 'Fuel is low. Find more or another power source.';
  return 'Strengthen the settlement for the final days.';
}

export function evaluateEnd(s: GameState, early = false): ScenarioResult {
  const alive = aliveSurvivors(s).length;
  const sys = systemStatus(s);
  const systems = [sys.power, sys.water, sys.food].filter(Boolean).length;
  const objs = objectives(s);
  const optionalDone = objs.filter((o) => o.optional && o.done).length;
  const lines: string[] = [];
  const def = CATASTROPHES[s.world.catastrophe];
  lines.push(`${def.name} (${def.kind.toLowerCase()}), ${difficultyInfo(s.world.difficulty).label.toLowerCase()}${s.world.mode === 'sandbox' ? ', sandbox' : ''}${s.world.extra.length ? ` + ${s.world.extra.map((x) => CATASTROPHES[x].name).join(', ')}` : ''}.`);
  lines.push(`${alive} of ${s.survivors.length} survivors alive.`);
  for (const d of s.stats.deaths) lines.push(d.cause.startsWith('left') ? `${d.name} ${d.cause} on Day ${dayOf(d.minute)}.` : `${d.name} died of ${d.cause} on Day ${dayOf(d.minute)}.`);
  lines.push(`Power: ${sys.power ? 'reliable' : 'unreliable'} — ${s.stats.powerHours.toFixed(0)} powered hours, ${count(s, 'fuel').toFixed(1)} L fuel left.`);
  lines.push(`Water: ${sys.water ? 'safe supply running' : 'no reliable treated supply'} — ${s.stats.cleanWaterMade.toFixed(0)} L treated, ${count(s, 'water').toFixed(0)} L in store.`);
  lines.push(`Food: ${sys.food ? 'beds producing' : 'not sustainable yet'} — ${s.stats.foodGrown} rations grown, ${count(s, 'food')} in store.`);
  lines.push(`Built ${s.stats.built}, repaired ${s.stats.repaired}, dismantled ${s.stats.dismantled}.`);
  const working = s.objects.filter((o) => o.state === 'operational' && ['generator', 'waterPump', 'waterTank', 'batteryBank', 'sandFilter', 'purifier', 'windTurbine', 'radio', 'gate', 'workbench', 'lamp'].includes(o.type));
  if (working.length) lines.push(`Working infrastructure: ${working.map((o) => OBJECT_DEFS[o.type].name).join(', ')}.`);
  if (s.stats.stormDamage.length) lines.push(`Storm damage: ${s.stats.stormDamage.join('; ')}.`);

  const endless = !!s.flags.endless;
  if (endless) lines.unshift(`Endured ${dayOf(s.minute) - 1} days — the first week graded ${String(s.flags.endlessGrade ?? '?').toLowerCase()}.`);
  let status: ScenarioResult['status'] = 'won';
  let grade = '';
  let headline = '';
  if (early || alive < 3) {
    status = 'lost';
    grade = 'Settlement lost';
    headline = alive === 0 ? 'Nobody is left at the compound.' : 'Too few remain to keep the compound alive.';
    if (endless) headline = `Held out for ${dayOf(s.minute) - 1} days before the end.`;
  } else if (systems < 2) {
    status = 'lost';
    grade = 'Abandoned';
    headline = 'Seven days survived, but without working systems the group packs up and walks north.';
  } else if (systems === 3 && s.stats.deaths.length === 0 && optionalDone >= 2) {
    grade = 'Thriving settlement';
    headline = 'Power hums, water runs clean, the beds are green — and everyone made it.';
  } else if (systems === 3 && alive >= 4) {
    grade = 'Functioning settlement';
    headline = 'The compound works. It’s a place people could live.';
  } else {
    grade = 'Holding on';
    headline = 'Battered, short of something, but standing.';
  }
  return {
    status,
    grade,
    headline,
    lines,
    objectives: objs.map((o) => ({ id: o.id, label: o.label, done: o.done })),
  };
}
