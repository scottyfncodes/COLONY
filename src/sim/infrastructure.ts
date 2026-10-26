import { OBJECT_DEFS } from './actions';
import { cleanCapacity, consumeUpTo, count, log, produce, rawCapacity, roomFor } from './inventory';
import { jobsOn, queueAction, queueTreat } from './jobs';
import { hashNoise } from './rng';
import { isNight } from './time';
import { isSheltered } from './world';
import type { GameState, ItemId, WorldObject } from './types';

// Infrastructure communicates only through shared state: fuel and water in the
// store, power flowing through state.power, and object states/conditions.

export const GEN_OUTPUT = 6; // kW
export const BATTERY_CAPACITY = 30; // kWh
export const PUMP_RATE = 30; // L/h
export const SAND_RATE = 5; // L/h
export const PURIFIER_RATE = 15; // L/h
export const GROW_HOURS = 36;

function ops(state: GameState, type: WorldObject['type']): WorldObject[] {
  return state.objects.filter((o) => o.type === type && o.state === 'operational');
}

export function generator(state: GameState): WorldObject | undefined {
  return state.objects.find((o) => o.type === 'generator');
}

/** Decide which consumers want power this minute and what they'd draw. */
export function consumerDemand(state: GameState, o: WorldObject): number {
  if (o.state !== 'operational' || !o.on) return 0;
  const draw = OBJECT_DEFS[o.type].draw ?? 0;
  switch (o.type) {
    case 'waterPump':
      return count(state, 'rawWater') < rawCapacity(state) - 0.01 ? draw : 0;
    case 'purifier':
      return count(state, 'rawWater') > 0.01 && count(state, 'water') < cleanCapacity(state) - 0.01 ? draw : 0;
    case 'workbench':
      return state.jobs.some((j) => j.targetId === o.id && j.kind === 'craft' && j.phase === 'work') ? draw : 0;
    case 'lamp':
      return isNight(state.minute) ? draw : 0;
    case 'radio':
      return draw;
    default:
      return 0;
  }
}

export function windAt(state: GameState): number {
  if (state.weather.kind === 'storm') return 1;
  const hour = Math.floor(state.minute / 60);
  const a = hashNoise(state.seed, hour);
  const b = hashNoise(state.seed, hour + 1);
  const f = (state.minute % 60) / 60;
  return 0.15 + 0.6 * (a * (1 - f) + b * f) + (state.weather.kind === 'rain' ? 0.15 : 0);
}

export function turbineOutput(state: GameState, o: WorldObject): number {
  if (o.type !== 'windTurbine' || o.state !== 'operational' || !o.on) return 0;
  return Math.min(3, 2.6 * state.weather.wind);
}

export function tickPower(state: GameState): void {
  const p = state.power;
  const gen = generator(state);
  const bank = ops(state, 'batteryBank')[0];
  p.capacity = bank ? BATTERY_CAPACITY : 0;
  p.stored = Math.min(p.stored, p.capacity);

  const consumers = state.objects.filter((o) => (OBJECT_DEFS[o.type].draw ?? 0) > 0);
  // Priority: water first, then light, then workshop, then radio.
  const priority: Record<string, number> = { waterPump: 0, purifier: 1, lamp: 2, workbench: 3, radio: 4 };
  consumers.sort((a, b) => (priority[a.type] ?? 9) - (priority[b.type] ?? 9));
  const wants = consumers.map((o) => ({ o, kw: consumerDemand(state, o) }));
  const demand = wants.reduce((t, w) => t + w.kw, 0);

  let free = 0;
  for (const t of state.objects) free += turbineOutput(state, t);

  const genAvailable = !!gen && gen.state === 'operational' && gen.on && count(state, 'fuel') > 0;
  // Smart controller: with a battery, the generator only starts when stored energy runs low.
  const deficitAfterFree = Math.max(0, demand - free);
  const fromBatteryMax = bank ? Math.min(6, p.stored * 60) : 0;
  let genRun = false;
  if (genAvailable) {
    if (!bank) genRun = deficitAfterFree > 0;
    else if (gen!.data.running) genRun = p.stored < p.capacity * 0.95 || deficitAfterFree > fromBatteryMax;
    else genRun = p.stored < p.capacity * 0.25 || deficitAfterFree > fromBatteryMax;
  }
  if (gen) {
    if (genRun && !gen.data.running) gen.data.running = 1;
    else if (!genRun && gen.data.running) gen.data.running = 0;
  }
  const condFactor = gen ? (gen.condition < 40 ? 0.7 : 1) : 0;
  const genMax = genRun ? GEN_OUTPUT * condFactor : 0;

  // Supply available this minute (kW). Battery can discharge up to 6 kW.
  let available = free + genMax + fromBatteryMax;
  let deficit = false;
  for (const w of wants) {
    if (w.kw <= 0) {
      w.o.powered = w.o.state === 'operational' && w.o.on && (OBJECT_DEFS[w.o.type].draw ?? 0) > 0 && available > 0;
      continue;
    }
    if (available + 1e-9 >= w.kw) {
      available -= w.kw;
      w.o.powered = true;
    } else {
      w.o.powered = false;
      deficit = true;
    }
  }
  const used = wants.reduce((t, w) => t + (w.o.powered ? w.kw : 0), 0);

  // Energy balance: free power first, then generator, then battery.
  let need = used;
  const fromFree = Math.min(free, need);
  need -= fromFree;
  let genUsed = Math.min(genMax, need);
  need -= genUsed;
  const fromBattery = Math.min(fromBatteryMax, need);
  need -= fromBattery;
  // Surplus charges the battery: unused free power plus generator headroom while running.
  let charge = 0;
  if (bank) {
    const room = (p.capacity - p.stored) * 60; // kW over a minute
    const surplusFree = free - fromFree;
    const surplusGen = genMax - genUsed;
    const c1 = Math.min(surplusFree, room);
    const c2 = Math.min(surplusGen, Math.max(0, room - c1));
    charge = c1 + c2;
    genUsed += c2;
  }
  p.stored = Math.max(0, Math.min(p.capacity, p.stored + (charge * 0.9 - fromBattery) / 60));

  // Fuel: idle burn plus load.
  let burn = 0;
  if (gen && genRun) {
    burn = (0.12 + 0.05 * genUsed) * (gen.data.efficient ? 0.75 : 1);
    const got = consumeUpTo(state, 'fuel', burn / 60);
    gen.condition = Math.max(0, gen.condition - 0.2 / 60);
    if (got + 1e-9 < burn / 60 || count(state, 'fuel') <= 0) {
      gen.data.running = 0;
      if (!state.flags.warnedFuel) {
        log(state, 'The generator sputters and dies: out of fuel.', 'bad');
        state.flags.warnedFuel = true;
      }
    }
    if (gen.condition <= 5 && gen.state === 'operational') {
      gen.state = 'broken';
      gen.issues = ['Worn out — bearings failed'];
      gen.data.running = 0;
      log(state, 'The generator grinds to a halt. It was never serviced.', 'bad');
    }
  }
  if (count(state, 'fuel') > 1) state.flags.warnedFuel = false;

  p.supply = free + genMax;
  p.demand = demand;
  p.deficit = deficit;
  p.fuelBurn = burn;
  if (demand > 0 && !deficit) state.stats.powerHours += 1 / 60;
}

export function tickWater(state: GameState): void {
  const w = state.water;
  w.rawCap = rawCapacity(state);
  w.cleanCap = cleanCapacity(state);
  // Spill anything above capacity (a leaking tank loses water it can't hold).
  const rawOver = count(state, 'rawWater') - w.rawCap;
  if (rawOver > 0) consumeUpTo(state, 'rawWater', Math.min(rawOver, 2));
  let rawIn = 0;
  let cleanIn = 0;
  for (const o of ops(state, 'waterPump')) {
    if (o.on && o.powered) rawIn += produce(state, { rawWater: PUMP_RATE / 60 }).rawWater ?? 0;
  }
  const rain = state.weather.rain;
  if (rain > 0) {
    const catchers = ops(state, 'rainCatcher').length;
    if (catchers) rawIn += produce(state, { rawWater: (rain * 25 * catchers) / 60 }).rawWater ?? 0;
  }
  const treat = (rate: number) => {
    const room = cleanCapacity(state) - count(state, 'water');
    const amt = Math.min(rate / 60, count(state, 'rawWater'), Math.max(0, room));
    if (amt <= 0) return;
    consumeUpTo(state, 'rawWater', amt);
    produce(state, { water: amt });
    cleanIn += amt;
    state.stats.cleanWaterMade += amt;
  };
  for (const o of ops(state, 'sandFilter')) if (o.on) treat(o.data.cartridge ? SAND_RATE * 2 : SAND_RATE);
  for (const o of ops(state, 'purifier')) if (o.on && o.powered) treat(PURIFIER_RATE);
  w.rawIn = rawIn * 60;
  w.cleanIn = cleanIn * 60;
}

export function irrigated(state: GameState): boolean {
  return state.objects.some((o) => o.type === 'pipes' && o.state === 'laid');
}

export function tickCrops(state: GameState): void {
  const irrig = irrigated(state);
  for (const o of state.objects) {
    if (o.type !== 'planter' || o.state !== 'growing') continue;
    if (state.weather.rain > 0 && !isSheltered(o.x, o.y)) o.data.moisture = Math.min(100, (o.data.moisture ?? 0) + state.weather.rain * 2);
    o.data.moisture = Math.max(0, (o.data.moisture ?? 0) - 100 / (24 * 60));
    if (irrig && o.data.moisture < 60) {
      const got = consumeUpTo(state, 'rawWater', 0.04 * (100 - o.data.moisture) / 25);
      o.data.moisture = Math.min(100, o.data.moisture + got * 25);
    }
    if (o.data.moisture > 0) {
      o.data.growth = Math.min(100, (o.data.growth ?? 0) + 100 / (GROW_HOURS * 60));
      o.data.dry = 0;
    } else {
      o.data.dry = (o.data.dry ?? 0) + 1;
      if (o.data.dry > 18 * 60) {
        o.state = 'damaged';
        o.data.growth = 0;
        o.issues = ['Crop withered'];
        log(state, 'A planter dried out and the crop withered.', 'bad');
      }
    }
    if (o.data.growth >= 100) {
      o.state = 'ready';
      log(state, 'A planter is ready to harvest.', 'good');
    }
  }
}

export function tickWeather(state: GameState): void {
  const wx = state.weather;
  const m = state.minute;
  const prev = wx.kind;
  if (m >= wx.stormStart && m < wx.stormEnd) {
    wx.kind = 'storm';
    wx.rain = 1;
  } else if (wx.rainWindows.some((r) => m >= r.start && m < r.end)) {
    wx.kind = 'rain';
    wx.rain = 0.45;
  } else {
    const soon = wx.stormStart - m;
    wx.kind = soon > 0 && soon < 10 * 60 ? 'overcast' : 'clear';
    wx.rain = 0;
  }
  wx.wind = windAt(state);
  if (prev !== wx.kind && wx.kind === 'rain') log(state, 'Rain begins to fall.', 'info');
  if (prev === 'rain' && wx.kind !== 'rain') log(state, 'The rain eases off.', 'info');
}

/** Generate routine jobs so crops and patients aren't forgotten (player can still cancel them). */
export function autoJobs(state: GameState): void {
  if (state.minute % 15 !== 0) return;
  const irrig = irrigated(state);
  for (const o of state.objects) {
    if (o.type !== 'planter') continue;
    if (jobsOn(state, o.id).length) continue;
    let action: string | null = null;
    if (o.state === 'ready') action = 'harvest';
    else if (o.state === 'growing' && !irrig && (o.data.moisture ?? 0) < 45 && state.weather.rain === 0) action = 'water';
    if (action) {
      const r = queueAction(state, o.id, action);
      if (r.ok) state.jobs[state.jobs.length - 1].auto = true;
    }
  }
  for (const s of state.survivors) {
    if (!s.alive || s.away) continue;
    if ((s.injury >= 30 || s.sick > 0 || s.health < 45) && count(state, 'meds') >= 1) {
      if (!state.jobs.some((j) => j.kind === 'treat' && j.targetId === s.id)) queueTreat(state, s.id, null, true);
    }
  }
  for (const o of state.objects) {
    const fits = (Object.keys(o.contents) as ItemId[]).some((k) => roomFor(state, k) >= 1);
    if (o.type === 'crate' && o.state === 'pile' && fits && !jobsOn(state, o.id).length) {
      const r = queueAction(state, o.id, 'haulCrate');
      if (r.ok) state.jobs[state.jobs.length - 1].auto = true;
    }
  }
}

