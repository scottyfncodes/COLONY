import { dispatch, step } from '../src/sim/sim';
import { count } from '../src/sim/inventory';
import { jobsOn } from '../src/sim/jobs';
import { defense, isActive } from '../src/sim/catastrophes';
import type { GameState, ObjectType, WorldObject } from '../src/sim/types';

// A simple scripted player used by tests to drive full playthroughs in every scenario.

function q(s: GameState, o: WorldObject | undefined, action: string) {
  if (!o || jobsOn(s, o.id).length) return;
  dispatch(s, { type: 'queueAction', objectId: o.id, actionId: action });
}

const find = (s: GameState, type: string, st?: string) => s.objects.filter((o) => o.type === type && (!st || o.state === st));
const PREFER = ['help', 'welcome', 'strip', 'note', 'fill', 'drain', 'isolate', 'talk', 'take', 'hold', 'dark', 'kessler', 'pay', 'bribe'];

function build(s: GameState, type: ObjectType, spots: [number, number][]): void {
  for (const [x, y] of spots) if (dispatch(s, { type: 'build', blueprint: type, x, y }).ok) return;
}

export function botThink(s: GameState): void {
  if (s.events.pending) {
    const c = PREFER.map((id) => s.events.pending!.choices.find((x) => x.id === id && x.available)).find(Boolean) ?? s.events.pending.choices.find((x) => x.available)!;
    dispatch(s, { type: 'choose', choiceId: c.id });
    return;
  }
  // Emergencies first.
  for (const o of s.objects) if (o.data.burning) q(s, o, 'douse');
  const trap = s.objects.find((o) => o.type === 'rubble' && o.state === 'pile' && o.data.trapped);
  if (trap) q(s, trap, 'digOut');
  for (const x of s.survivors) {
    if (!x.alive || x.away) continue;
    if (x.illness?.kind === 'fever' && x.illness.stage === 'sick' && !x.quarantined) dispatch(s, { type: 'quarantine', survivorId: x.id, value: true });
    if (x.quarantined && !x.illness) dispatch(s, { type: 'quarantine', survivorId: x.id, value: false });
  }
  for (const p of find(s, 'scrapPile', 'pile')) q(s, p, 'salvage');
  for (const r of find(s, 'rubble', 'pile')) if (!r.data.trapped) q(s, r, 'clearRubble');
  q(s, find(s, 'wreckedCar', 'wreck')[0], 'siphon');
  q(s, find(s, 'drums', 'pile')[0], 'drain');
  const gen = find(s, 'generator')[0];
  const fork = find(s, 'forklift')[0];
  if (fork.state === 'broken') q(s, fork, 'pullEngine');
  if (gen.state === 'broken' && count(s, 'engine') > 0) q(s, gen, 'fitEngine');
  if (gen.state === 'flooded') q(s, gen, 'dryOut');
  if (gen.state === 'operational' && gen.condition < 60) q(s, gen, 'service');
  const pump = find(s, 'waterPump')[0];
  if (pump.state === 'broken') q(s, pump, 'repairPump');
  if (pump.state === 'flooded') q(s, pump, 'dryPump');
  q(s, find(s, 'workbench', 'damaged')[0], 'repairBench');
  q(s, find(s, 'waterTank', 'damaged')[0], 'patchTank');
  for (const p of find(s, 'planter')) {
    if (p.state === 'overgrown' || p.state === 'damaged') q(s, p, 'clear');
    if (p.state === 'empty' && count(s, 'food') > 4) q(s, p, 'plant');
  }
  const filters = s.objects.filter((o) => o.type === 'sandFilter');
  if (!filters.length && count(s, 'scrap') >= 4 && count(s, 'mech') >= 1) build(s, 'sandFilter', [[22, 13], [20, 14], [12, 13]]);
  // Scenario-specific preparation.
  if (isActive(s, 'quake') && s.objects.filter((o) => o.type === 'levee').length < 2 && count(s, 'scrap') >= 1) build(s, 'levee', [[13, 21], [16, 21], [10, 21], [5, 21]]);
  if (isActive(s, 'pandemic') && !s.objects.some((o) => o.type === 'infirmary') && count(s, 'scrap') >= 3) build(s, 'infirmary', [[8, 16], [8, 18], [7, 15]]);
  if ((isActive(s, 'collapse') || isActive(s, 'outbreak')) && s.objects.filter((o) => o.type === 'barricade').length < 3 && count(s, 'scrap') >= 6 && filters.length)
    build(s, 'barricade', [[26, 12], [26, 19], [24, 21], [26, 22], [12, 27]]);
  if (isActive(s, 'outbreak') && gen.state === 'operational') {
    const loud = s.world.horde > defense(s).value * 8;
    if (loud === gen.on) dispatch(s, { type: 'toggle', objectId: gen.id });
  }
  const planters = find(s, 'planter');
  if (planters.length < 4 && count(s, 'scrap') >= 3 && filters.length) build(s, 'planter', [[17, 23], [17, 25], [17, 27]]);
  const sf = filters.find((f) => f.state === 'operational' && !f.data.cartridge);
  if (sf && count(s, 'filter') > 0) q(s, sf, 'cartridges');
  if (!s.world.climax.resolved && s.minute > s.world.climax.at - 36 * 60) {
    for (const o of [gen, pump, ...find(s, 'waterTank'), ...find(s, 'batteryBank', 'operational'), ...find(s, 'planter', 'growing')]) if (!o.reinforced) q(s, o, 'reinforce');
  }
  const gate = find(s, 'gate', 'damaged')[0];
  if (gate && count(s, 'scrap') >= 6 && count(s, 'mech') >= 1) q(s, gate, 'repairGate');
  const bat = find(s, 'batteryBank', 'damaged')[0];
  if (bat && count(s, 'battery') >= 2 && count(s, 'elec') >= 2) q(s, bat, 'recell');
  const radio = find(s, 'radio', 'broken')[0];
  if (radio && count(s, 'elec') >= 2) q(s, radio, 'repairRadio');
  // Expeditions: market first, then garage, then pump station.
  const busy = s.expeditions.some((e) => e.phase !== 'done');
  if (!busy && s.weather.kind !== 'storm') {
    const plan: [string, string[]][] = [
      ['market', ['s-june', 's-sol']],
      ['garage', ['s-june', 's-rusk']],
      ['pumpStation', ['s-june', 's-sol']],
    ];
    for (const [dest, team] of plan) {
      const loc = s.locations[dest as 'market'];
      if (loc.visits > 0) continue;
      const fit = team.filter((id) => {
        const m = s.survivors.find((x) => x.id === id)!;
        return m.alive && !m.away && m.energy > 40 && m.health > 50 && !m.trapped && !m.quarantined && !m.illness;
      });
      if (fit.length === team.length && count(s, 'water') >= 8) {
        const r = dispatch(s, { type: 'expedition', destination: dest as 'market', members: team, packed: { water: 6, ...(count(s, 'meds') > 3 ? { meds: 1 } : {}) }, vehicle: false });
        if (!r.ok && /route|road|blocked|bridge|overpass|checkpoint|wander|hot spot|culvert/i.test(r.message)) continue;
      }
      break;
    }
  }
}

export function playBot(s: GameState, minutes: number): void {
  for (let i = 0; i < minutes; i++) {
    if (s.result) return;
    if (i % 30 === 0 || s.events.pending) botThink(s);
    step(s);
  }
}
