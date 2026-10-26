import { dispatch, step } from '../src/sim/sim';
import { count } from '../src/sim/inventory';
import { jobsOn } from '../src/sim/jobs';
import type { GameState, WorldObject } from '../src/sim/types';

// A simple scripted player used by tests to drive full playthroughs.

function q(s: GameState, o: WorldObject | undefined, action: string) {
  if (!o || jobsOn(s, o.id).length) return;
  dispatch(s, { type: 'queueAction', objectId: o.id, actionId: action });
}

const find = (s: GameState, type: string, st?: string) => s.objects.filter((o) => o.type === type && (!st || o.state === st));

export function botThink(s: GameState): void {
  if (s.events.pending) {
    const c = s.events.pending.choices.find((x) => x.available && ['help', 'welcome', 'strip', 'note', 'fill', 'drain'].includes(x.id)) ?? s.events.pending.choices.find((x) => x.available)!;
    dispatch(s, { type: 'choose', choiceId: c.id });
    return;
  }
  for (const p of find(s, 'scrapPile', 'pile')) q(s, p, 'salvage');
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
  if (!filters.length && count(s, 'scrap') >= 4 && count(s, 'mech') >= 1 && pump.state === 'operational') {
    dispatch(s, { type: 'build', blueprint: 'sandFilter', x: 22, y: 13 });
  }
  const planters = find(s, 'planter');
  if (planters.length < 4 && count(s, 'scrap') >= 3 && filters.length) {
    dispatch(s, { type: 'build', blueprint: 'planter', x: 17, y: 23 + (planters.length - 2) * 2 });
  }
  const sf = filters.find((f) => f.state === 'operational' && !f.data.cartridge);
  if (sf && count(s, 'filter') > 0) q(s, sf, 'cartridges');
  // Storm prep.
  if (s.minute > s.weather.stormStart - 36 * 60 && !s.weather.stormResolved) {
    for (const o of [gen, pump, ...find(s, 'waterTank'), ...find(s, 'batteryBank', 'operational')]) if (!o.reinforced) q(s, o, 'reinforce');
  }
  const bat = find(s, 'batteryBank', 'damaged')[0];
  if (bat && count(s, 'battery') >= 2 && count(s, 'elec') >= 2) q(s, bat, 'recell');
  const radio = find(s, 'radio', 'broken')[0];
  if (radio && count(s, 'elec') >= 2) q(s, radio, 'repairRadio');
  const gate = find(s, 'gate', 'damaged')[0];
  if (gate && count(s, 'scrap') >= 8 && count(s, 'mech') >= 2) q(s, gate, 'repairGate');
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
        return m.alive && !m.away && m.energy > 40 && m.health > 50;
      });
      if (fit.length === team.length && count(s, 'water') >= 8) {
        dispatch(s, { type: 'expedition', destination: dest as 'market', members: team, packed: { water: 6 }, vehicle: false });
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
