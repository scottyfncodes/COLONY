import { describe, expect, it } from 'vitest';
import { advance, dispatch, newGame, step, validatePlacement } from '../src/sim/sim';
import { consume, count, deposit, produce, take, worldTotal } from '../src/sim/inventory';
import { addItems, ITEM_IDS } from '../src/sim/items';
import { availableActions, getObject } from '../src/sim/jobs';
import { deserialize, serialize } from '../src/sim/save';
import { EVENTS, runEvents } from '../src/sim/events';
import { createGame } from '../src/sim/setup';
import { END_MINUTE } from '../src/sim/time';
import type { GameState, Items } from '../src/sim/types';
import { playBot } from './bot';

function game(seed = 7): GameState {
  const s = newGame(seed);
  expect(s.events.pending?.id).toBe('intro');
  dispatch(s, { type: 'choose', choiceId: 'begin' });
  return s;
}

/** Step until predicate holds, auto-resolving decisions with their first available choice. */
function runUntil(s: GameState, pred: () => boolean, max = 3000): number {
  for (let i = 0; i < max; i++) {
    if (pred()) return i;
    if (s.events.pending) {
      const c = s.events.pending.choices.find((x) => x.available)!;
      dispatch(s, { type: 'choose', choiceId: c.id });
    }
    step(s);
  }
  throw new Error('condition never met');
}

/** Advance, answering any decisions with their first available choice. */
function advanceAuto(s: GameState, minutes: number): void {
  for (let i = 0; i < minutes; i++) {
    if (s.result) return;
    if (s.events.pending) dispatch(s, { type: 'choose', choiceId: s.events.pending.choices.find((x) => x.available)!.id });
    step(s);
  }
}

function checkConservation(s: GameState, initial: Items) {
  const expected = addItems(addItems(initial, s.ledger.produced), s.ledger.consumed, -1);
  const actual = worldTotal(s);
  for (const k of ITEM_IDS) {
    expect(actual[k] ?? 0).toBeCloseTo(expected[k] ?? 0, 6);
    expect(s.inventory[k] ?? 0).toBeGreaterThanOrEqual(-1e-9);
  }
}

describe('inventory accounting', () => {
  it('produces, consumes, takes and deposits without creating or losing items', () => {
    const s = createGame(1);
    const before = { ...s.inventory };
    produce(s, { scrap: 3 });
    consume(s, { scrap: 2 });
    const carrier: Items = {};
    expect(take(s, { scrap: 1, mech: 1 }, carrier)).toBe(true);
    expect(take(s, { mech: 99 }, carrier)).toBe(false);
    deposit(s, carrier);
    expect(carrier).toEqual({});
    expect(count(s, 'scrap')).toBe((before.scrap ?? 0) + 1);
    expect(s.ledger.produced.scrap).toBe(3);
    expect(s.ledger.consumed.scrap).toBe(2);
  });

  it('refuses to overdraw', () => {
    const s = createGame(1);
    expect(() => consume(s, { fuel: 999 })).toThrow();
    expect(count(s, 'fuel')).toBe(5);
  });

  it('caps liquids at container capacity', () => {
    const s = createGame(1);
    const got = produce(s, { rawWater: 500 });
    expect(got.rawWater).toBe(60); // 20 L barrels + 40 L in the leaking tank
    expect(count(s, 'rawWater')).toBe(60);
  });
});

describe('jobs: repair, dismantle, repurpose', () => {
  it('pulls the forklift engine and fits it to the generator', () => {
    const s = game();
    const elecBefore = count(s, 'elec');
    expect(dispatch(s, { type: 'queueAction', objectId: 'forklift', actionId: 'pullEngine', assigneeId: 's-ines' }).ok).toBe(true);
    runUntil(s, () => count(s, 'engine') === 1);
    expect(getObject(s, 'forklift')!.state).toBe('stripped');
    expect(dispatch(s, { type: 'queueAction', objectId: 'generator', actionId: 'fitEngine', assigneeId: 's-ines' }).ok).toBe(true);
    runUntil(s, () => getObject(s, 'generator')!.state === 'operational');
    expect(count(s, 'engine')).toBe(0);
    expect(count(s, 'elec')).toBe(elecBefore - 1);
    expect(getObject(s, 'generator')!.data.efficient).toBe(1);
    // The stripped forklift can no longer be repaired.
    expect(availableActions(s, getObject(s, 'forklift')!).map((a) => a.id)).toEqual(['dismantle']);
  });

  it('waits for missing materials without consuming anything', () => {
    const s = game();
    const inv = { ...s.inventory };
    dispatch(s, { type: 'queueAction', objectId: 'generator', actionId: 'overhaul', assigneeId: 's-ines' });
    advance(s, 120);
    const job = s.jobs.find((j) => j.targetId === 'generator')!;
    expect(job.phase).toBe('queued');
    expect(job.blockedReason).toMatch(/Needs/);
    expect(getObject(s, 'generator')!.state).toBe('broken');
    expect(count(s, 'mech')).toBe(inv.mech);
    expect(count(s, 'elec')).toBe(inv.elec);
  });

  it('dismantling recovers parts and permanently removes function', () => {
    const s = game();
    const mech = count(s, 'mech');
    dispatch(s, { type: 'queueAction', objectId: 'forklift', actionId: 'dismantle', assigneeId: 's-theo' });
    runUntil(s, () => !s.jobs.some((j) => j.targetId === 'forklift'));
    const f = getObject(s, 'forklift')!;
    expect(f.state).toBe('dismantled');
    expect(count(s, 'mech')).toBe(mech + 3);
    expect(count(s, 'battery')).toBe(1);
    expect(availableActions(s, f)).toHaveLength(0);
    expect(dispatch(s, { type: 'queueAction', objectId: 'forklift', actionId: 'pullEngine' }).ok).toBe(false);
  });

  it('rejects duplicate jobs on the same object', () => {
    const s = game();
    expect(dispatch(s, { type: 'queueAction', objectId: 'car', actionId: 'siphon' }).ok).toBe(true);
    expect(dispatch(s, { type: 'queueAction', objectId: 'car', actionId: 'siphon' }).ok).toBe(false);
    expect(dispatch(s, { type: 'queueAction', objectId: 'car', actionId: 'dismantle' }).ok).toBe(false);
  });

  it('cancelling a job mid-way refunds staged materials', () => {
    const s = game();
    dispatch(s, { type: 'queueAction', objectId: 'workbench', actionId: 'repairBench', assigneeId: 's-rusk' });
    const scrap = count(s, 'scrap');
    runUntil(s, () => s.jobs[0]?.phase === 'travel');
    expect(count(s, 'scrap')).toBe(scrap - 2);
    dispatch(s, { type: 'cancelJob', jobId: s.jobs[0].id });
    expect(count(s, 'scrap')).toBe(scrap);
    expect(getObject(s, 'workbench')!.state).toBe('damaged');
  });

  it('salvaging a heap transports its contents to storage', () => {
    const s = game();
    const pile = s.objects.find((o) => o.type === 'scrapPile')!;
    const contents = { ...pile.contents };
    const scrap = count(s, 'scrap');
    dispatch(s, { type: 'queueAction', objectId: pile.id, actionId: 'salvage', assigneeId: 's-june' });
    runUntil(s, () => s.jobs.find((j) => j.targetId === pile.id)?.phase === 'haul');
    // Goods are in the worker's hands, not yet in storage.
    expect(count(s, 'scrap')).toBe(scrap);
    runUntil(s, () => !s.jobs.some((j) => j.targetId === pile.id));
    expect(count(s, 'scrap')).toBe(scrap + (contents.scrap ?? 0));
    expect(pile.contents).toEqual({});
  });
});

describe('construction', () => {
  it('validates placement', () => {
    const s = game();
    expect(validatePlacement(s, 'cot', 0, 0)).toMatch(/fence/);
    expect(validatePlacement(s, 'cot', 24, 5)).toMatch(/in the way/);
    expect(validatePlacement(s, 'cot', 7, 16)).toBeNull();
  });

  it('builds a structure, consuming materials on completion', () => {
    const s = game();
    const scrap = count(s, 'scrap');
    expect(dispatch(s, { type: 'build', blueprint: 'cot', x: 7, y: 16, assigneeId: 's-rusk' }).ok).toBe(true);
    const site = s.objects[s.objects.length - 1];
    expect(site.state).toBe('site');
    runUntil(s, () => site.state === 'operational');
    expect(site.type).toBe('cot');
    expect(count(s, 'scrap')).toBe(scrap - 3);
  });
});

describe('infrastructure', () => {
  function powered(s: GameState) {
    const g = getObject(s, 'generator')!;
    g.state = 'operational';
    g.on = true;
    g.condition = 90;
    const p = getObject(s, 'pump')!;
    p.state = 'operational';
    p.on = true;
    return { g, p };
  }

  it('generator powers the pump, which fills untreated storage and burns fuel', () => {
    const s = game();
    powered(s);
    const fuel = count(s, 'fuel');
    advance(s, 60);
    expect(count(s, 'rawWater')).toBeGreaterThan(25);
    expect(count(s, 'fuel')).toBeLessThan(fuel);
    expect(s.power.supply).toBeGreaterThan(0);
  });

  it('no fuel means no power and no pumping', () => {
    const s = game();
    powered(s);
    consume(s, { fuel: count(s, 'fuel') });
    advance(s, 60);
    expect(count(s, 'rawWater')).toBe(0);
    expect(getObject(s, 'pump')!.powered).toBe(false);
  });

  it('sand filter turns untreated water into clean water', () => {
    const s = game();
    produce(s, { rawWater: 30 });
    s.objects.push({ ...getObject(s, 'lamp-yard')!, id: 'sf', type: 'sandFilter', x: 22, y: 13, state: 'operational', on: true });
    const clean = count(s, 'water');
    advance(s, 60);
    // 5 L/h treated, minus whatever survivors drank.
    expect(s.stats.cleanWaterMade).toBeCloseTo(5, 5);
    expect(count(s, 'rawWater')).toBeLessThan(30);
    expect(count(s, 'water') + 0).toBeGreaterThan(clean - 15);
  });

  it('crops grow when watered and wither when dry', () => {
    const s = game();
    const p = getObject(s, 'planter-a')!;
    p.state = 'growing';
    p.data = { growth: 0, moisture: 100 };
    s.jobs = [];
    advance(s, 37 * 60);
    expect(['ready', 'growing', 'damaged']).toContain(p.state);
  });
});

describe('survivors', () => {
  it('eat and drink from stores over a day', () => {
    const s = game();
    const food = count(s, 'food');
    const water = count(s, 'water');
    advance(s, 24 * 60);
    expect(count(s, 'food')).toBeLessThan(food);
    expect(count(s, 'water')).toBeLessThan(water);
    expect(s.survivors.every((x) => x.alive)).toBe(true);
  });

  it('suffer and eventually die without water', () => {
    const s = game();
    consume(s, { water: count(s, 'water') });
    for (const x of s.survivors) x.autoWork = false;
    advanceAuto(s, 3 * 24 * 60);
    expect(s.stats.deaths.length).toBeGreaterThan(0);
    expect(s.stats.deaths[0].cause).toBe('dehydration');
  });

  it('skilled workers are faster than unskilled ones', () => {
    const a = game();
    const b = game();
    dispatch(a, { type: 'queueAction', objectId: 'forklift', actionId: 'pullEngine', assigneeId: 's-ines' });
    dispatch(b, { type: 'queueAction', objectId: 'forklift', actionId: 'pullEngine', assigneeId: 's-amara' });
    const ta = runUntil(a, () => count(a, 'engine') === 1);
    const tb = runUntil(b, () => count(b, 'engine') === 1);
    expect(ta).toBeLessThan(tb);
  });
});

describe('time', () => {
  it('advances one minute per step and pauses on decisions', () => {
    const s = newGame(3);
    const m = s.minute;
    step(s);
    expect(s.minute).toBe(m); // intro pending
    dispatch(s, { type: 'choose', choiceId: 'begin' });
    step(s);
    expect(s.minute).toBe(m + 1);
    advance(s, 100);
    expect(s.minute).toBe(m + 101);
  });
});

describe('expeditions', () => {
  it('sends a team, makes a location decision, and returns real cargo', () => {
    const s = game();
    const food = count(s, 'food');
    const r = dispatch(s, { type: 'expedition', destination: 'market', members: ['s-june', 's-sol'], packed: { water: 4 }, vehicle: false });
    expect(r.ok).toBe(true);
    expect(s.survivors.find((x) => x.id === 's-june')!.away).toBe(true);
    runUntil(s, () => s.events.pending?.id === 'expeditionDecision', 2000);
    dispatch(s, { type: 'choose', choiceId: 'force' });
    expect(s.flags.raidedCache).toBe(true);
    runUntil(s, () => !s.survivors.find((x) => x.id === 's-june')!.away, 2000);
    expect(count(s, 'food')).toBeGreaterThan(food - 6);
    expect(s.locations.market.visits).toBe(1);
    expect(s.locations.market.loot.food ?? 0).toBeLessThan(18);
  });

  it('enforces team rules', () => {
    const s = game();
    const all = s.survivors.map((x) => x.id);
    expect(dispatch(s, { type: 'expedition', destination: 'garage', members: all.slice(0, 4), packed: {}, vehicle: false }).ok).toBe(false);
    expect(dispatch(s, { type: 'expedition', destination: 'garage', members: ['s-june'], packed: {}, vehicle: true }).ok).toBe(false);
    expect(dispatch(s, { type: 'expedition', destination: 'garage', members: ['s-june'], packed: { fuel: 99 }, vehicle: false }).ok).toBe(false);
  });
});

describe('storm and encounter', () => {
  it('reinforced machinery survives the storm; exposed machinery floods', () => {
    const s = game();
    const g = getObject(s, 'generator')!;
    const p = getObject(s, 'pump')!;
    g.state = 'operational';
    p.state = 'operational';
    g.reinforced = true;
    s.minute = s.weather.stormStart - 1;
    runUntil(s, () => s.minute >= s.weather.stormStart + 5 * 60 + 1);
    expect(g.state).toBe('operational');
    expect(p.state).toBe('flooded');
    expect(s.stats.stormDamage.join(' ')).toMatch(/Well pump/);
  });

  it('turning the Kesslers away leads to a raid unless the gate is secured', () => {
    for (const gateFixed of [false, true]) {
      const s = game();
      if (gateFixed) getObject(s, 'gate')!.state = 'operational';
      s.minute = 2 * 24 * 60 + 10 * 60;
      runUntil(s, () => s.events.pending?.id === 'kesslerArrive');
      dispatch(s, { type: 'choose', choiceId: 'refuse' });
      produce(s, { fuel: 10 });
      const fuel = count(s, 'fuel');
      s.minute = 5 * 24 * 60 + 1 * 60;
      s.weather.stormStart = 99999;
      s.weather.stormEnd = 99999;
      runUntil(s, () => !!s.events.fired.kesslerRaid);
      if (gateFixed) expect(count(s, 'fuel')).toBeGreaterThan(fuel - 1);
      else expect(count(s, 'fuel')).toBeLessThan(fuel - 3);
    }
  });

  it('helping the Kesslers brings Pavel to the compound', () => {
    const s = game();
    produce(s, { water: 40 });
    s.minute = 2 * 24 * 60 + 10 * 60;
    runUntil(s, () => s.events.pending?.id === 'kesslerArrive');
    dispatch(s, { type: 'choose', choiceId: 'help' });
    runUntil(s, () => s.events.pending?.id === 'kesslerJoin', 3 * 24 * 60);
    dispatch(s, { type: 'choose', choiceId: 'welcome' });
    expect(s.survivors.some((x) => x.id === 's-pavel')).toBe(true);
  });

  it('every event definition has a unique id', () => {
    expect(new Set(EVENTS.map((e) => e.id)).size).toBe(EVENTS.length);
  });
});

describe('water fallbacks', () => {
  it('a bucket from the well yields untreated water without power', () => {
    const s = game();
    expect(getObject(s, 'pump')!.state).toBe('broken');
    dispatch(s, { type: 'queueAction', objectId: 'pump', actionId: 'bucket', assigneeId: 's-rusk' });
    runUntil(s, () => !s.jobs.some((j) => j.actionId === 'bucket'));
    expect(s.ledger.produced.rawWater).toBe(10);
  });

  it('boiling at the mess table turns untreated water into drinking water', () => {
    const s = game();
    produce(s, { rawWater: 10 });
    const made = s.stats.cleanWaterMade;
    dispatch(s, { type: 'queueAction', objectId: 'table', actionId: 'boil', assigneeId: 's-sol' });
    runUntil(s, () => !s.jobs.some((j) => j.actionId === 'boil'));
    expect(s.ledger.produced.water).toBe(7);
    expect(s.stats.cleanWaterMade).toBe(made + 7);
  });

  it('rain fills the barrels and tank even without rain catchers', () => {
    const s = game();
    for (const x of s.survivors) x.autoWork = false;
    s.minute = s.weather.stormStart;
    advance(s, 0);
    runUntil(s, () => s.minute >= s.weather.stormStart + 3 * 60);
    expect(s.ledger.produced.rawWater ?? 0).toBeGreaterThan(30);
  });

  it('the pump station always provides untreated water', () => {
    const s = game();
    s.locations.pumpStation.loot = {};
    s.locations.pumpStation.decisionDone = true;
    dispatch(s, { type: 'expedition', destination: 'pumpStation', members: ['s-june', 's-sol'], packed: { water: 6 }, vehicle: false });
    const raw = count(s, 'rawWater');
    runUntil(s, () => !s.survivors.find((x) => x.id === 's-june')!.away, 3000);
    expect(count(s, 'rawWater')).toBeGreaterThan(raw + 15);
  });
});

describe('save / load', () => {
  it('round-trips and stays deterministic', () => {
    const s = game(11);
    playBot(s, 600);
    const copy = deserialize(serialize(s));
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    playBot(s, 600);
    playBot(copy.state, 600);
    expect(serialize(copy.state)).toBe(serialize(s));
  });

  it('rejects malformed or outdated saves', () => {
    expect(deserialize('{nope').ok).toBe(false);
    expect(deserialize(null).ok).toBe(false);
    const s = createGame(1);
    expect(deserialize(JSON.stringify({ ...s, version: 1 })).ok).toBe(false);
    expect(deserialize(JSON.stringify({ ...s, inventory: { scrap: -5 } })).ok).toBe(false);
    expect(deserialize(JSON.stringify({ ...s, survivors: 'x' })).ok).toBe(false);
    expect(deserialize(JSON.stringify({ ...s, inventory: { gold: 5 } })).ok).toBe(false);
  });
});

describe('full scenario', () => {
  it('a competent player reaches the end of Day 7 with every item accounted for', () => {
    const s = newGame(42);
    const initial = worldTotal(s);
    for (let h = 0; h < 7 * 24 + 2 && !s.result; h++) {
      playBot(s, 60);
      checkConservation(s, initial);
      for (const x of s.survivors) {
        expect(Number.isFinite(x.x) && Number.isFinite(x.y)).toBe(true);
        expect(x.hunger).toBeGreaterThanOrEqual(0);
      }
      // No job is held by two workers, and every worker's job exists.
      const held = s.survivors.filter((x) => x.jobId).map((x) => x.jobId);
      expect(new Set(held).size).toBe(held.length);
    }
    expect(s.result).not.toBeNull();
    expect(s.minute).toBeGreaterThanOrEqual(END_MINUTE);
    expect(s.result!.status).toBe('won');
  });

  it('is deterministic for a seed', () => {
    const a = newGame(5);
    const b = newGame(5);
    playBot(a, 3000);
    playBot(b, 3000);
    expect(serialize(a)).toBe(serialize(b));
  });

  it('an idle settlement fails with understandable causes', () => {
    const s = newGame(9);
    runEvents(s);
    for (const x of s.survivors) x.autoWork = false;
    for (let i = 0; i < 8 * 24 * 60 && !s.result; i++) {
      if (s.events.pending) dispatch(s, { type: 'choose', choiceId: s.events.pending.choices.find((c) => c.available)!.id });
      step(s);
    }
    expect(s.result?.status).toBe('lost');
    expect(s.result!.lines.join(' ')).toMatch(/died of (dehydration|starvation|illness)/);
  });
});
