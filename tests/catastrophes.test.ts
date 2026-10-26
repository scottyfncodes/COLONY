import { describe, expect, it } from 'vitest';
import { advance, dispatch, newGame, step } from '../src/sim/sim';
import { count, produce, worldTotal } from '../src/sim/inventory';
import { addItems, ITEM_IDS } from '../src/sim/items';
import { getObject, getSurvivor } from '../src/sim/jobs';
import { deserialize, serialize } from '../src/sim/save';
import { CATASTROPHE_IDS, CATASTROPHES, defense, ignite, infect, radiationNow } from '../src/sim/catastrophes';
import { DIRECTOR_EVENTS, directorEvent, startEvent, tickDirector } from '../src/sim/director';
import { NEVER } from '../src/sim/setup';
import type { CatastropheId, GameState, Items } from '../src/sim/types';
import { playBot } from './bot';

function start(c: CatastropheId, seed = 5, extra: Partial<Parameters<typeof newGame>[1]> = {}): GameState {
  const s = newGame(seed, { catastrophe: c, ...extra });
  dispatch(s, { type: 'choose', choiceId: 'begin' });
  return s;
}

/** Advance, answering any decisions with their first available choice. */
function run(s: GameState, minutes: number, pred?: () => boolean): void {
  for (let i = 0; i < minutes; i++) {
    if (pred && pred()) return;
    if (s.result) return;
    if (s.events.pending) dispatch(s, { type: 'choose', choiceId: s.events.pending.choices.find((x) => x.available)!.id });
    step(s);
  }
}

describe('scenario initialisation', () => {
  it('Storm Season is the original game, unchanged', () => {
    const s = start('storm');
    expect(s.world.catastrophe).toBe('storm');
    expect(s.world.climax.kind).toBe('storm');
    expect(s.inventory).toMatchObject({ scrap: 6, mech: 1, elec: 1, fuel: 5, food: 14, water: 24, meds: 2 });
    expect(s.survivors.every((x) => !x.trapped && !x.illness)).toBe(true);
  });

  it('Aftershock traps a survivor under rubble, blocks the yard and cuts the market road', () => {
    const s = start('quake');
    const sol = getSurvivor(s, 's-sol')!;
    expect(sol.trapped).toBe(true);
    expect(s.objects.filter((o) => o.type === 'rubble').length).toBeGreaterThanOrEqual(5);
    expect(s.objects.find((o) => o.type === 'rubble' && o.data.trapped)).toBeTruthy();
    expect(dispatch(s, { type: 'expedition', destination: 'market', members: ['s-june'], packed: {}, vehicle: false }).message).toMatch(/overpass/);
  });

  it('Blackout starts with almost no fuel, no storm and a raid climax', () => {
    const s = start('collapse');
    expect(count(s, 'fuel')).toBe(1);
    expect(s.weather.stormStart).toBeGreaterThanOrEqual(NEVER);
    expect(s.world.climax.kind).toBe('raid');
    expect(s.world.threat).toBe(20);
    expect(s.locations.market.loot.food).toBeLessThan(18);
  });

  it('The Fever starts with Theo incubating and extra medical supplies', () => {
    const s = start('pandemic');
    expect(getSurvivor(s, 's-theo')!.illness).toMatchObject({ kind: 'fever', stage: 'incubating' });
    expect(count(s, 'meds')).toBe(4);
  });

  it('Black Rain starts with outdoor radiation that decays over time', () => {
    const s = start('fallout');
    const r0 = radiationNow(s);
    expect(r0).toBeGreaterThan(5);
    s.weather.rainWindows = [];
    run(s, 48 * 60);
    expect(s.world.radiation).toBeLessThan(r0 / 2);
  });

  it('The Infected starts with the infected massing, no storm and a horde climax', () => {
    const s = start('outbreak');
    expect(s.world.horde).toBe(15);
    expect(s.world.climax.kind).toBe('horde');
    expect(s.weather.stormStart).toBeGreaterThanOrEqual(NEVER);
  });

  it('difficulty scales starting supplies', () => {
    const easy = start('storm', 5, { difficulty: 'easy' });
    const hard = start('storm', 5, { difficulty: 'hard' });
    expect(count(easy, 'food')).toBeGreaterThan(count(hard, 'food'));
    expect(count(easy, 'water')).toBeGreaterThan(count(hard, 'water'));
  });

  it('random selection is decided by the seed and covers several catastrophes', () => {
    const picks = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const a = newGame(seed, { random: true });
      const b = newGame(seed, { random: true });
      expect(a.world.catastrophe).toBe(b.world.catastrophe);
      expect(a.world.random).toBe(true);
      picks.add(a.world.catastrophe);
    }
    expect(picks.size).toBeGreaterThanOrEqual(4);
  });

  it('the intro briefing comes from the chosen catastrophe', () => {
    for (const id of CATASTROPHE_IDS) {
      const s = newGame(3, { catastrophe: id });
      expect(s.events.pending?.title).toContain(CATASTROPHES[id].name);
    }
  });
});

describe('scenario mechanics', () => {
  it('digging out the trapped survivor frees them; leaving them is fatal', () => {
    const a = start('quake');
    const r = a.objects.find((o) => o.type === 'rubble' && o.data.trapped)!;
    expect(dispatch(a, { type: 'queueAction', objectId: r.id, actionId: 'digOut', assigneeId: 's-rusk' }).ok).toBe(true);
    run(a, 600, () => !getSurvivor(a, 's-sol')!.trapped);
    expect(getSurvivor(a, 's-sol')!.trapped).toBe(false);
    expect(getSurvivor(a, 's-sol')!.alive).toBe(true);

    const b = start('quake');
    for (const x of b.survivors) x.autoWork = false;
    run(b, 3 * 24 * 60, () => !getSurvivor(b, 's-sol')!.alive);
    expect(b.stats.deaths.find((d) => d.name === 'Sol Brenner')?.cause).toBe('being crushed under rubble');
  });

  it('levees keep the flood off the growing plot', () => {
    for (const levees of [0, 2]) {
      const s = start('quake');
      for (const x of s.survivors) x.trapped = false;
      const p = getObject(s, 'planter-a')!;
      p.state = 'growing';
      p.reinforced = true; // covered against the storm itself; only the flood can hurt it
      p.data = { growth: 10, moisture: 100 };
      for (let i = 0; i < levees; i++) s.objects.push({ ...p, id: `lv${i}`, type: 'levee', x: 5 + i * 3, y: 27, w: 2, h: 1, state: 'operational', data: {} });
      s.minute = s.weather.stormStart - 1;
      run(s, 8 * 60);
      if (levees) {
        expect(s.world.flood).toBeLessThan(50);
        expect(p.state).not.toBe('damaged');
      } else {
        expect(s.flags.floodHit).toBe(true);
        expect(p.state).toBe('damaged');
      }
    }
  });

  it('radiation dose builds much faster outdoors than indoors', () => {
    const s = start('fallout');
    const inside = getSurvivor(s, 's-ines')!;
    const outside = getSurvivor(s, 's-rusk')!;
    for (const x of s.survivors) x.autoWork = false;
    outside.x = 16.5;
    outside.y = 15.5;
    outside.moveTarget = null;
    for (let i = 0; i < 120; i++) {
      outside.x = 16.5;
      outside.y = 15.5;
      step(s);
    }
    expect(outside.dose).toBeGreaterThan(inside.dose * 5);
  });

  it('boiling is blocked in fallout; filters still work', () => {
    const s = start('fallout');
    produce(s, { rawWater: 20 });
    expect(dispatch(s, { type: 'queueAction', objectId: 'table', actionId: 'boil' }).message).toMatch(/fallout/);
  });

  it('quarantine in an isolation bed stops the fever spreading', () => {
    const spread = (quarantine: boolean) => {
      const s = start('pandemic', 9);
      for (const x of s.survivors) {
        x.autoWork = false;
        x.illness = null;
      }
      const sick = getSurvivor(s, 's-theo')!;
      sick.illness = { kind: 'fever', stage: 'sick', t: 40 * 60 };
      s.objects.push({ ...getObject(s, 'cot-1')!, id: 'iso', type: 'infirmary', x: 8, y: 16 });
      s.world.director.intensity = 0;
      if (quarantine) dispatch(s, { type: 'quarantine', survivorId: sick.id, value: true });
      for (let i = 0; i < 24 * 60; i++) {
        const ev = s.events.pending;
        if (ev) dispatch(s, { type: 'choose', choiceId: (ev.choices.find((x) => x.id === (quarantine ? 'isolate' : 'keep')) ?? ev.choices[0]).id });
        step(s);
      }
      return s.survivors.filter((x) => x.id !== sick.id && x.illness).length;
    };
    expect(spread(true)).toBe(0);
    expect(spread(false)).toBeGreaterThan(0);
  });

  it('a bite kills unless treated, and treatment works', () => {
    const a = start('outbreak');
    const v = getSurvivor(a, 's-june')!;
    infect(v, 'bite', 1);
    a.world.director.intensity = 0;
    for (const x of a.survivors) x.autoWork = false;
    run(a, 3 * 24 * 60, () => !v.alive);
    expect(a.stats.deaths.some((d) => d.cause === 'an infected bite')).toBe(true);

    const b = start('outbreak');
    infect(getSurvivor(b, 's-june')!, 'bite', 6);
    dispatch(b, { type: 'treat', patientId: 's-june', assigneeId: 's-amara' });
    run(b, 600, () => !getSurvivor(b, 's-june')!.illness);
    expect(getSurvivor(b, 's-june')!.illness).toBeNull();
    expect(count(b, 'meds')).toBe(2);
  });

  it('a running generator makes noise', () => {
    const s = start('outbreak');
    const g = getObject(s, 'generator')!;
    g.state = 'operational';
    g.on = true;
    produce(s, { fuel: 10 });
    getObject(s, 'pump')!.state = 'operational';
    getObject(s, 'pump')!.on = true;
    s.world.director.intensity = 0;
    for (const x of s.survivors) x.autoWork = false;
    run(s, 90);
    expect(g.data.running).toBe(1);
    expect(s.world.noise).toBeGreaterThan(40);
  });

  it('noise draws the infected; silence lets them drift off', () => {
    const loud = start('outbreak');
    const quiet = start('outbreak');
    for (const s of [loud, quiet]) {
      s.world.director.intensity = 0;
      for (const x of s.survivors) x.autoWork = false;
      for (let i = 0; i < 18 * 60; i++) {
        s.world.noise = s === loud ? 80 : 0;
        step(s);
        if (s.events.pending) dispatch(s, { type: 'choose', choiceId: s.events.pending.choices.find((x) => x.available)!.id });
      }
    }
    expect(loud.world.horde).toBeGreaterThan(quiet.world.horde + 10);
  });

  it('defences decide the raid; paying them off always ends it', () => {
    const strong = start('collapse');
    getObject(strong, 'gate')!.state = 'operational';
    for (let i = 0; i < 3; i++) strong.objects.push({ ...getObject(strong, 'cot-1')!, id: `b${i}`, type: 'barricade', x: 20 + i * 3, y: 22, w: 2, h: 1 });
    strong.world.threat = 20;
    strong.minute = strong.world.climax.at - 1;
    run(strong, 5, () => strong.events.pending?.id === 'raidClimax');
    expect(defense(strong).value).toBeGreaterThan(8);
    const food = count(strong, 'food');
    dispatch(strong, { type: 'choose', choiceId: 'hold' });
    expect(count(strong, 'food')).toBe(food);
    expect(strong.world.climax.resolved).toBe(true);

    const weak = start('collapse');
    weak.minute = weak.world.climax.at - 1;
    run(weak, 5, () => weak.events.pending?.id === 'raidClimax');
    const f2 = count(weak, 'food');
    dispatch(weak, { type: 'choose', choiceId: 'pay' });
    expect(count(weak, 'food')).toBeLessThan(f2);
    expect(weak.world.climax.resolved).toBe(true);
  });

  it('a fire is put out with water, or burns the object out', () => {
    const a = start('storm');
    const gen = getObject(a, 'generator')!;
    gen.state = 'operational';
    ignite(a, gen, 'Test:');
    produce(a, { rawWater: 20 });
    expect(dispatch(a, { type: 'queueAction', objectId: gen.id, actionId: 'douse', assigneeId: 's-sol' }).ok).toBe(true);
    run(a, 180, () => !gen.data.burning);
    expect(gen.data.burning).toBeFalsy();
    expect(gen.state).toBe('operational');

    const b = start('storm');
    const g2 = getObject(b, 'generator')!;
    g2.state = 'operational';
    b.weather.rainWindows = [];
    for (const x of b.survivors) x.autoWork = false;
    ignite(b, g2, 'Test:');
    run(b, 200);
    expect(g2.state).toBe('broken');
  });
});

describe('event director', () => {
  it('only offers events whose prerequisites hold', () => {
    const s = start('storm');
    expect(directorEvent('genFailure')!.prereq(s)).toBe(false); // generator is broken
    const g = getObject(s, 'generator')!;
    g.state = 'operational';
    g.condition = 30;
    g.data.running = 1;
    expect(directorEvent('genFailure')!.prereq(s)).toBe(true);
    expect(directorEvent('aftershock')!.prereq(s)).toBe(false); // no quake
    expect(directorEvent('nightRaid')!.prereq(s)).toBe(false);
  });

  it('warns first, and servicing the generator averts the failure', () => {
    const s = start('storm');
    const g = getObject(s, 'generator')!;
    g.state = 'operational';
    g.condition = 30;
    g.data.running = 1;
    startEvent(s, directorEvent('genFailure')!);
    expect(s.world.director.pending.some((p) => p.id === 'genFailure')).toBe(true);
    expect(s.log[s.log.length - 1].text).toMatch(/knocking/);
    g.condition = 80; // serviced
    s.minute = s.world.director.pending[0].at;
    tickDirector(s);
    expect(g.state).toBe('operational');
    expect(s.log[s.log.length - 1].text).toMatch(/smoothly/);
  });

  it('bad water is averted when clean water starts flowing', () => {
    const s = start('storm');
    s.flags.rawDrinks = 5;
    startEvent(s, directorEvent('badWater')!);
    s.objects.push({ ...getObject(s, 'cot-1')!, id: 'sf', type: 'sandFilter', x: 22, y: 13 });
    s.minute = s.world.director.pending[0].at;
    tickDirector(s);
    expect(s.survivors.every((x) => x.sick <= 0)).toBe(true);
  });

  it('respects caps, cooldowns and rest periods over a whole campaign', () => {
    for (const c of CATASTROPHE_IDS) {
      const s = newGame(21, { catastrophe: c });
      const starts: { id: string; t: number; adverse: boolean }[] = [];
      let lastCounts: Record<string, number> = {};
      for (let i = 0; i < 7 * 24 * 60 && !s.result; i++) {
        if (s.events.pending) dispatch(s, { type: 'choose', choiceId: s.events.pending.choices.find((x) => x.available)!.id });
        step(s);
        for (const [id, n] of Object.entries(s.world.director.counts)) {
          if (n !== (lastCounts[id] ?? 0)) starts.push({ id, t: s.minute, adverse: directorEvent(id)!.adverse });
        }
        lastCounts = { ...s.world.director.counts };
      }
      for (const e of DIRECTOR_EVENTS) expect(s.world.director.counts[e.id] ?? 0).toBeLessThanOrEqual(e.max);
      const adverse = starts.filter((x) => x.adverse).map((x) => x.t);
      for (let i = 1; i < adverse.length; i++) expect(adverse[i] - adverse[i - 1]).toBeGreaterThanOrEqual(14 * 60);
      for (const e of DIRECTOR_EVENTS) {
        const ts = starts.filter((x) => x.id === e.id).map((x) => x.t);
        for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(e.cooldown);
      }
    }
  });

  it('the director is deterministic for a seed', () => {
    const a = newGame(31, { catastrophe: 'collapse' });
    const b = newGame(31, { catastrophe: 'collapse' });
    playBot(a, 3000);
    playBot(b, 3000);
    expect(serialize(a)).toBe(serialize(b));
  });
});

describe('sandbox', () => {
  it('is refused in survival games', () => {
    const s = start('storm');
    expect(dispatch(s, { type: 'sandbox', action: { kind: 'supplies', amount: 'lots' } }).ok).toBe(false);
  });

  it('layers catastrophes, clamps conditions and triggers valid events', () => {
    const s = start('storm', 5, { mode: 'sandbox' });
    expect(dispatch(s, { type: 'sandbox', action: { kind: 'addCatastrophe', catastrophe: 'fallout' } }).ok).toBe(true);
    expect(s.world.extra).toContain('fallout');
    expect(radiationNow(s)).toBeGreaterThan(5);
    expect(dispatch(s, { type: 'sandbox', action: { kind: 'addCatastrophe', catastrophe: 'fallout' } }).ok).toBe(false);
    dispatch(s, { type: 'sandbox', action: { kind: 'setCondition', key: 'horde', value: 999 } });
    expect(s.world.horde).toBe(100);
    dispatch(s, { type: 'sandbox', action: { kind: 'setCondition', key: 'radiation', value: -5 } });
    expect(s.world.radiation).toBe(0);
    expect(dispatch(s, { type: 'sandbox', action: { kind: 'triggerEvent', eventId: 'aftershock' } }).ok).toBe(false); // no quake
    expect(dispatch(s, { type: 'sandbox', action: { kind: 'addCatastrophe', catastrophe: 'quake' } }).ok).toBe(true);
    expect(dispatch(s, { type: 'sandbox', action: { kind: 'triggerEvent', eventId: 'aftershock' } }).ok).toBe(true);
    expect(dispatch(s, { type: 'sandbox', action: { kind: 'weather', weather: 'squall' } }).ok).toBe(true);
    run(s, 120);
    expect(s.weather.rain).toBeGreaterThan(0.9);
    // State remains valid and saveable.
    const back = deserialize(serialize(s));
    expect(back.ok).toBe(true);
  });
});

describe('saves', () => {
  it('migrates a version 3 save into Storm Season', () => {
    const s = start('storm');
    advance(s, 60);
    const raw = JSON.parse(serialize(s));
    raw.version = 3;
    delete raw.world;
    for (const x of raw.survivors) {
      delete x.dose;
      delete x.illness;
      delete x.trapped;
      delete x.quarantined;
    }
    const r = deserialize(JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.world.catastrophe).toBe('storm');
    expect(r.state.survivors[0].dose).toBe(0);
    run(r.state, 600);
    expect(r.state.minute).toBeGreaterThan(s.minute);
  });

  it('rejects saves missing world conditions', () => {
    const raw = JSON.parse(serialize(start('fallout')));
    delete raw.world;
    expect(deserialize(JSON.stringify(raw)).ok).toBe(false);
  });
});

describe('whole campaigns', () => {
  function conservation(s: GameState, initial: Items) {
    const expected = addItems(addItems(initial, s.ledger.produced), s.ledger.consumed, -1);
    const actual = worldTotal(s);
    for (const k of ITEM_IDS) {
      expect(actual[k] ?? 0).toBeCloseTo(expected[k] ?? 0, 5);
      expect(s.inventory[k] ?? 0).toBeGreaterThanOrEqual(-1e-9);
    }
  }

  it.each(CATASTROPHE_IDS)('%s plays to the end with every item accounted for and no invalid state', (c) => {
    const s = newGame(42, { catastrophe: c });
    const initial = worldTotal(s);
    for (let h = 0; h < 7 * 24 + 2 && !s.result; h++) {
      playBot(s, 60);
      if (h % 6 === 0) conservation(s, initial);
      for (const x of s.survivors) {
        expect(Number.isFinite(x.x) && Number.isFinite(x.y) && Number.isFinite(x.dose)).toBe(true);
        if (x.quarantined) expect(x.jobId).toBeNull();
      }
    }
    expect(s.result).not.toBeNull();
    expect(s.result!.status).toBe('won');
  });

  it('catastrophes produce materially different campaigns', () => {
    const sig = (c: CatastropheId) => {
      const s = newGame(42, { catastrophe: c });
      playBot(s, 3 * 24 * 60);
      return {
        dose: Math.max(...s.survivors.map((x) => x.dose)),
        fever: s.survivors.filter((x) => x.immune || x.illness?.kind === 'fever').length,
        fuel: s.ledger.produced.fuel ?? 0,
        rubble: s.objects.filter((o) => o.type === 'rubble').length,
        horde: s.world.horde,
        threat: s.world.threat,
      };
    };
    const storm = sig('storm');
    expect(sig('fallout').dose).toBeGreaterThan(storm.dose + 20);
    expect(sig('pandemic').fever).toBeGreaterThan(storm.fever);
    expect(sig('collapse').fuel).toBeLessThan(storm.fuel);
    expect(sig('quake').rubble).toBeGreaterThan(storm.rubble);
    expect(sig('outbreak').horde).toBeGreaterThan(storm.horde + 10);
    expect(sig('collapse').threat).toBeGreaterThan(storm.threat);
  });
});
