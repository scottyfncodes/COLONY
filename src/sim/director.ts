import { objectName, OBJECT_DEFS } from './actions';
import { contact, defense, ignite, infect, isActive, mods, scheduleSquall } from './catastrophes';
import { consume, count, log, produce } from './inventory';
import { describeItems } from './items';
import { getSurvivor } from './jobs';
import { LOCATIONS } from './expeditions';
import { chance, nextRandom, randInt } from './rng';
import { DRIFTERS, makeSurvivor } from './setup';
import { presentSurvivors, aliveSurvivors } from './survivors';
import { dayOf, isNight } from './time';
import { isSheltered } from './world';
import type { EventDef } from './events';
import type { GameState, Items, LocationId, PendingEvent, WorldObject } from './types';

// The event director generates secondary crises and opportunities from the actual
// state of the world. Every event has prerequisites, a weight, a cooldown and a
// cap. Most adverse events warn first and only strike if the cause is still there
// when the warning runs out, so players can prevent or soften them. After a crisis
// the director rests, and it eases off when the settlement is already struggling.

export interface DirectorEvent {
  id: string;
  title: string;
  adverse: boolean;
  /** Minutes between occurrences. */
  cooldown: number;
  max: number;
  /** Can this happen now? */
  prereq: (s: GameState) => boolean;
  /** Relative likelihood when eligible. */
  weight: (s: GameState) => number;
  /** Optional warning: returns follow-up data; the strike comes `delay` minutes later. */
  warn?: { delay: number; text: (s: GameState, d: Record<string, string | number>) => string; prepare?: (s: GameState) => Record<string, string | number> | null };
  /** The event itself. May return a decision for the player. */
  strike: (s: GameState, d: Record<string, string | number>) => PendingEvent | null;
  /** For warned events: is the cause still present? If not, the crisis is averted. */
  stillValid?: (s: GameState, d: Record<string, string | number>) => boolean;
  averted?: string;
  resolve?: EventDef['resolve'];
}

const H = 60;

function damagedCount(s: GameState): number {
  return s.objects.filter((o) => ['broken', 'damaged', 'flooded'].includes(o.state) && OBJECT_DEFS[o.type].stormVulnerable).length;
}

function exposedTargets(s: GameState): WorldObject[] {
  return s.objects.filter(
    (o) => OBJECT_DEFS[o.type].stormVulnerable && !o.reinforced && !isSheltered(o.x, o.y) && ['operational', 'growing', 'ready'].includes(o.state),
  );
}

function climaxSoon(s: GameState, hours: number): boolean {
  const c = s.world.climax;
  return !c.resolved && s.minute > c.at - hours * H && s.minute < c.end + 6 * H;
}

const pickLocation = (s: GameState): LocationId | null => {
  const ids = (Object.keys(LOCATIONS) as LocationId[]).filter((id) => !((s.world.routes[id]?.until ?? 0) > s.minute) && !s.expeditions.some((e) => e.destination === id && e.phase !== 'done'));
  return ids.length ? ids[randInt(s, 0, ids.length - 1)] : null;
};

export const DIRECTOR_EVENTS: DirectorEvent[] = [
  {
    id: 'squall',
    title: 'Squall',
    adverse: true,
    cooldown: 36 * H,
    max: 2,
    prereq: (s) => s.weather.kind === 'clear' && !climaxSoon(s, 24) && dayOf(s.minute) >= 2,
    weight: (s) => (damagedCount(s) >= 2 ? 1.6 : 0.5) * (isActive(s, 'quake') || isActive(s, 'storm') ? 1.4 : 1),
    warn: { delay: 6 * H, text: () => 'Dark clouds are building in the west. A squall will hit in about six hours: brace anything exposed.' },
    strike: (s) => {
      scheduleSquall(s, 3 * H);
      const t = exposedTargets(s).filter((o) => o.type !== 'planter');
      if (t.length) {
        const o = t[randInt(s, 0, t.length - 1)];
        o.condition = Math.max(0, o.condition - 30);
        if (o.type !== 'generator' || o.condition < 30) {
          o.state = o.type === 'rainCatcher' ? 'dismantled' : o.type === 'generator' || o.type === 'waterPump' ? 'flooded' : 'damaged';
          o.issues = ['Battered by the squall'];
        }
        log(s, `The squall hits hard: the ${objectName(o).toLowerCase()} took a beating.`, 'bad');
      } else log(s, 'The squall hits — and everything exposed is braced. Rain fills the barrels.', 'good');
      return null;
    },
  },
  {
    id: 'badWater',
    title: 'Bad water',
    adverse: true,
    cooldown: 48 * H,
    max: 2,
    prereq: (s) => Number(s.flags.rawDrinks ?? 0) >= 3 || (Number(s.flags.contaminatedUntil ?? 0) > s.minute && count(s, 'rawWater') > 10),
    weight: () => 1.4,
    warn: { delay: 6 * H, text: () => 'Stomach cramps all round. The untreated water may be bad — treat it before anyone else drinks it.' },
    stillValid: (s) => !s.objects.some((o) => (o.type === 'sandFilter' || o.type === 'purifier') && o.state === 'operational') && count(s, 'water') < 10,
    averted: 'Clean water is flowing, and the cramps pass without an outbreak.',
    strike: (s) => {
      const pool = presentSurvivors(s).filter((x) => x.sick <= 0);
      const n = Math.min(2, pool.length);
      const names: string[] = [];
      for (let i = 0; i < n; i++) {
        const v = pool.splice(randInt(s, 0, pool.length - 1), 1)[0];
        v.sick = 24 * 60;
        names.push(v.name.split(' ')[0]);
      }
      s.flags.rawDrinks = 0;
      log(s, `A stomach bug from the bad water: ${names.join(' and ')} are laid low.`, 'bad');
      return null;
    },
  },
  {
    id: 'genFailure',
    title: 'Generator failing',
    adverse: true,
    cooldown: 40 * H,
    max: 2,
    prereq: (s) => {
      const g = s.objects.find((o) => o.type === 'generator');
      return !!g && g.state === 'operational' && g.condition < 45 && !!g.data.running;
    },
    weight: () => 1.5,
    warn: { delay: 8 * H, text: () => 'The generator has started knocking badly. Service it soon or it will fail.' },
    stillValid: (s) => {
      const g = s.objects.find((o) => o.type === 'generator');
      return !!g && g.state === 'operational' && g.condition < 45;
    },
    averted: 'The generator runs smoothly again after its service.',
    strike: (s) => {
      const g = s.objects.find((o) => o.type === 'generator')!;
      if (chance(s, 0.35)) ignite(s, g, 'Oil on a hot exhaust:');
      else {
        g.state = 'broken';
        g.issues = ['Thrown con-rod'];
        g.data.running = 0;
        log(s, 'The generator throws a con-rod and dies. Treatment, pumping and lights stop until it is fixed.', 'bad');
      }
      return null;
    },
  },
  {
    id: 'routeBlocked',
    title: 'Route blocked',
    adverse: true,
    cooldown: 30 * H,
    max: 3,
    prereq: (s) => !Object.values(s.world.routes).some((r) => r && r.until > s.minute) && dayOf(s.minute) >= 2,
    weight: (s) => (isActive(s, 'quake') || isActive(s, 'collapse') || isActive(s, 'outbreak') ? 1.4 : 0.6),
    strike: (s) => {
      const loc = pickLocation(s);
      if (!loc) return null;
      const reason = isActive(s, 'collapse')
        ? 'Armed men have set up a checkpoint on the road.'
        : isActive(s, 'outbreak')
          ? 'A mass of infected is wandering the road.'
          : isActive(s, 'fallout')
            ? 'The road runs through a radiation hot spot.'
            : 'Fallen trees and a washed-out culvert block the road.';
      s.world.routes[loc] = { until: s.minute + randInt(s, 24, 36) * H, reason };
      log(s, `The route to ${LOCATIONS[loc].name} is blocked: ${reason.charAt(0).toLowerCase()}${reason.slice(1)} It should clear in a day or so.`, 'warn');
      return null;
    },
  },
  {
    id: 'hazardShift',
    title: 'Conditions change',
    adverse: true,
    cooldown: 40 * H,
    max: 2,
    prereq: (s) => dayOf(s.minute) >= 2 && !isActive(s, 'storm'),
    weight: () => 0.9,
    strike: (s) => {
      const loc = pickLocation(s) ?? 'garage';
      const note = isActive(s, 'fallout')
        ? 'The fallout plume shifted here'
        : isActive(s, 'outbreak')
          ? 'The infected are nesting here'
          : isActive(s, 'collapse')
            ? 'A gang has taken it over'
            : isActive(s, 'pandemic')
              ? 'A fever hot zone'
              : 'Aftershocks have made it unstable';
      s.world.hazards[loc] = { risk: 1.8, note, until: s.minute + 48 * H };
      log(s, `${LOCATIONS[loc].name}: ${note.toLowerCase()}. Expeditions there are far more dangerous for two days.`, 'warn');
      return null;
    },
  },
  {
    id: 'aftershock',
    title: 'Aftershock',
    adverse: true,
    cooldown: 16 * H,
    max: 3,
    prereq: (s) => isActive(s, 'quake') && !climaxSoon(s, 6),
    weight: (s) => 2.2 / Math.max(1, dayOf(s.minute) - 1),
    warn: { delay: 75, text: () => 'Dogs are howling and the water in the drums is trembling. An aftershock is coming.' },
    strike: (s) => {
      const hits: string[] = [];
      for (const o of s.objects) {
        if (o.reinforced || !OBJECT_DEFS[o.type].stormVulnerable || o.state !== 'operational') continue;
        if (!chance(s, 0.35)) continue;
        o.condition = Math.max(0, o.condition - 25);
        o.state = o.type === 'generator' || o.type === 'waterPump' ? 'flooded' : 'damaged';
        o.issues = ['Shaken loose by the aftershock'];
        hits.push(objectName(o).toLowerCase());
      }
      for (const x of presentSurvivors(s)) {
        if (!isSheltered(x.x, x.y) && chance(s, 0.12)) {
          x.injury = Math.min(100, x.injury + 25);
          hits.push(`${x.name.split(' ')[0]} hurt by falling debris`);
        }
      }
      log(s, `Aftershock!${hits.length ? ` ${hits.join(', ')}.` : ' Everything braced holds.'}`, hits.length ? 'bad' : 'good');
      return null;
    },
  },
  {
    id: 'wildfire',
    title: 'Wildfire embers',
    adverse: true,
    cooldown: 48 * H,
    max: 1,
    prereq: (s) => (isActive(s, 'quake') || isActive(s, 'collapse')) && s.weather.rain === 0 && dayOf(s.minute) >= 2 && exposedTargets(s).length > 0,
    weight: () => 0.8,
    warn: { delay: 4 * H, text: () => 'A wildfire is burning on the ridge and the wind is carrying embers this way. Keep water on hand.' },
    stillValid: (s) => s.weather.rain === 0,
    averted: 'The wind turns. The embers fall short of the fence.',
    strike: (s) => {
      const t = exposedTargets(s);
      if (t.length) ignite(s, t[randInt(s, 0, t.length - 1)], 'Embers land in the compound.');
      return null;
    },
  },
  {
    id: 'nightRaid',
    title: 'Night raid',
    adverse: true,
    cooldown: 30 * H,
    max: 2,
    prereq: (s) => isActive(s, 'collapse') && s.world.threat >= 50 && !climaxSoon(s, 18),
    weight: (s) => s.world.threat / 40,
    warn: { delay: 5 * H, text: () => 'Fires on the ridge and engines in the dark. The Ridge Crew are coming tonight.' },
    stillValid: (s) => s.world.threat >= 40,
    averted: 'The engines turn away. Whatever the Ridge Crew wanted, it wasn’t worth it tonight.',
    strike: (s) => {
      const d = defenseValue(s);
      const strength = 3 + s.world.threat / 15;
      if (d >= strength) {
        s.world.threat = Math.max(0, s.world.threat - 20);
        for (const x of presentSurvivors(s)) x.morale = Math.min(100, x.morale + 6);
        log(s, `Raiders test the fence in the night and find it too strong (defence ${d} vs ${strength.toFixed(0)}). They leave empty-handed.`, 'good');
      } else {
        const taken: Items = { food: Math.floor(count(s, 'food') * 0.25), fuel: Math.floor(count(s, 'fuel') * 0.3) };
        consume(s, { food: Math.min(count(s, 'food'), taken.food ?? 0), fuel: Math.min(count(s, 'fuel'), taken.fuel ?? 0) });
        s.world.threat = Math.max(0, s.world.threat - 10);
        log(s, `Raiders got in during the night (defence ${d} vs ${strength.toFixed(0)}) and took ${describeItems(taken)}.`, 'bad');
      }
      return null;
    },
  },
  {
    id: 'breach',
    title: 'Fence breach',
    adverse: true,
    cooldown: 20 * H,
    max: 3,
    prereq: (s) => isActive(s, 'outbreak') && dayOf(s.minute) >= 2 && s.world.horde > defenseValue(s) * 6 + 15 && !climaxSoon(s, 12),
    weight: () => 2,
    warn: { delay: 2 * H, text: (s) => `The infected are pressing on the fence (${Math.round(s.world.horde)} massing, defence ${defenseValue(s)}). Cut the noise or reinforce it, now.` },
    stillValid: (s) => s.world.horde > defenseValue(s) * 6 + 6,
    averted: 'The press of bodies at the fence thins out as the noise dies down.',
    strike: (s) => {
      const team = presentSurvivors(s).filter((x) => !x.trapped && !x.quarantined);
      const hurt: string[] = [];
      for (let i = 0; i < Math.min(2, team.length); i++) {
        const v = team.splice(randInt(s, 0, team.length - 1), 1)[0];
        v.injury = Math.min(100, v.injury + 25);
        if (chance(s, 0.35)) {
          infect(v, 'bite', 18);
          hurt.push(`${v.name.split(' ')[0]} was bitten`);
        } else hurt.push(`${v.name.split(' ')[0]} was hurt`);
      }
      s.world.horde = Math.max(0, s.world.horde - 30);
      const gate = s.objects.find((o) => o.type === 'gate');
      if (gate && gate.state === 'operational' && !gate.reinforced) {
        gate.state = 'damaged';
        gate.issues = ['Forced open by the infected'];
      }
      log(s, `The infected break through the fence! They are driven back, but ${hurt.join(' and ')}.`, 'bad');
      return null;
    },
  },
  {
    id: 'desertion',
    title: 'Someone wants to leave',
    adverse: true,
    cooldown: 30 * H,
    max: 2,
    prereq: (s) => presentSurvivors(s).some((x) => x.morale < 22 && !x.trapped && !x.quarantined) && aliveSurvivors(s).length > 3,
    weight: (s) => (isActive(s, 'collapse') ? 2 : 1),
    warn: {
      delay: 10 * H,
      prepare: (s) => {
        const v = presentSurvivors(s).filter((x) => x.morale < 22).sort((a, b) => a.morale - b.morale)[0];
        return v ? { who: v.id } : null;
      },
      text: (s, d) => `${getSurvivor(s, String(d.who))?.name ?? 'Someone'} is talking about leaving. Better food, a bed, light and company lift morale.`,
    },
    stillValid: (s, d) => {
      const v = getSurvivor(s, String(d.who));
      return !!v && v.alive && !v.away && v.morale < 28;
    },
    averted: 'Spirits lift. Nobody talks about leaving any more.',
    strike: (s, d) => {
      const v = getSurvivor(s, String(d.who))!;
      const empath = presentSurvivors(s).find((x) => x.trait === 'empath' && x.id !== v.id);
      return {
        id: 'desertion',
        title: `${v.name} is packing`,
        body: `${v.name} has a bag over one shoulder. “I can’t do this. There has to be somewhere better.”`,
        choices: [
          { id: 'talk', label: empath ? `${empath.name.split(' ')[0]} talks to them` : 'Talk them round', detail: 'Morale +25 if it works.', available: !!empath, reason: 'Needs someone they trust (Amara)' },
          { id: 'bribe', label: 'Promise them a better share', detail: 'Give them 2 extra rations now. Morale +20.', available: count(s, 'food') >= 2, reason: 'Needs 2 food' },
          { id: 'go', label: 'Let them go', detail: 'They take 2 food and 4 L water.', available: true },
        ],
        context: { who: v.id },
      };
    },
    resolve: (s, id, ev) => {
      const v = getSurvivor(s, ev.context.who);
      if (!v) return '';
      if (id === 'talk') {
        v.morale = Math.min(100, v.morale + 25);
        return `${v.name.split(' ')[0]} puts the bag down.`;
      }
      if (id === 'bribe') {
        consume(s, { food: 2 });
        v.morale = Math.min(100, v.morale + 20);
        v.hunger = Math.min(100, v.hunger + 40);
        return `${v.name.split(' ')[0]} eats, and stays.`;
      }
      consume(s, { food: Math.min(2, count(s, 'food')), water: Math.min(4, count(s, 'water')) });
      const job = s.jobs.find((j) => j.assigneeId === v.id);
      if (job) job.assigneeId = null;
      v.alive = false;
      v.jobId = null;
      v.activity = 'dead';
      v.causeOfDeath = 'left the settlement';
      s.stats.deaths.push({ name: v.name, cause: 'left the settlement', minute: s.minute });
      s.stats.choices.push(`${v.name} left the settlement`);
      for (const x of presentSurvivors(s)) x.morale = Math.max(0, x.morale - 8);
      return `${v.name} walks out of the gate and doesn’t look back.`;
    },
  },
  {
    id: 'drifter',
    title: 'A stranger at the gate',
    adverse: false,
    cooldown: 40 * H,
    max: 2,
    prereq: (s) => dayOf(s.minute) >= 2 && !climaxSoon(s, 12) && DRIFTERS.some((d) => !s.survivors.some((x) => x.id === d.id)) && s.weather.kind !== 'storm',
    weight: (s) => (count(s, 'food') >= aliveSurvivors(s).length * 2 ? 1.3 : 0.6),
    strike: (s) => {
      const seed = DRIFTERS.find((d) => !s.survivors.some((x) => x.id === d.id))!;
      const gift: Items = seed.role === 'Medic' ? { meds: 2, food: 2 } : seed.role === 'Builder' ? { scrap: 6, tools: 1 } : { fuel: 3, mech: 1 };
      const hidden = isActive(s, 'pandemic') ? 'They look pale, and sweat in the cold.' : isActive(s, 'outbreak') ? 'One sleeve is wrapped in a dirty bandage.' : isActive(s, 'collapse') ? 'Their eyes keep going to your stores.' : '';
      return {
        id: 'drifter',
        title: 'A stranger at the gate',
        body: `${seed.name}, a ${seed.role.toLowerCase()}, alone, carrying ${describeItems(gift)}. “I can work. I just need somewhere safe.”${hidden ? `\n\n${hidden}` : ''}`,
        choices: [
          { id: 'take', label: 'Take them in', detail: `Another skilled pair of hands, plus their ${describeItems(gift)}. Another mouth to feed.`, available: true },
          { id: 'trade', label: 'Trade, then send them on', detail: 'Swap 2 food for half of what they carry.', available: count(s, 'food') >= 2, reason: 'Needs 2 food' },
          { id: 'refuse', label: 'Turn them away', detail: 'No risk, no reward.', available: true },
        ],
        context: { who: seed.id, gift: JSON.stringify(gift) },
      };
    },
    resolve: (s, id, ev) => {
      const seed = DRIFTERS.find((d) => d.id === ev.context.who)!;
      const gift = JSON.parse(ev.context.gift) as Items;
      if (id === 'take') {
        const p = makeSurvivor(seed, dayOf(s.minute));
        p.morale = 60;
        s.survivors.push(p);
        produce(s, gift);
        s.stats.choices.push(`Took in ${seed.name}`);
        if (isActive(s, 'pandemic') && chance(s, 0.4)) infect(p, 'fever', randInt(s, 8, 16));
        if (isActive(s, 'outbreak') && chance(s, 0.3)) infect(p, 'bite', randInt(s, 6, 10));
        if (isActive(s, 'collapse') && chance(s, 0.25)) s.flags.thief = p.id;
        return `${seed.name.split(' ')[0]} joins the settlement.`;
      }
      if (id === 'trade') {
        consume(s, { food: 2 });
        const half: Items = {};
        for (const k of Object.keys(gift) as (keyof Items)[]) half[k] = Math.max(1, Math.floor((gift[k] ?? 0) / 2));
        produce(s, half);
        contact(s, 0.15);
        return `A fair swap: ${describeItems(half)}. ${seed.name.split(' ')[0]} walks on.`;
      }
      return `${seed.name.split(' ')[0]} nods, and walks on.`;
    },
  },
  {
    id: 'thief',
    title: 'Theft in the night',
    adverse: true,
    cooldown: 24 * H,
    max: 1,
    prereq: (s) => !!s.flags.thief && !!getSurvivor(s, String(s.flags.thief))?.alive && isNight(s.minute),
    weight: () => 3,
    strike: (s) => {
      const v = getSurvivor(s, String(s.flags.thief))!;
      const taken = { food: Math.min(count(s, 'food'), 4), fuel: Math.min(count(s, 'fuel'), 3) };
      consume(s, taken);
      v.alive = false;
      v.activity = 'dead';
      v.causeOfDeath = 'left the settlement';
      const job = s.jobs.find((j) => j.assigneeId === v.id);
      if (job) job.assigneeId = null;
      v.jobId = null;
      s.stats.deaths.push({ name: v.name, cause: 'left the settlement', minute: s.minute });
      s.flags.thief = '';
      s.stats.choices.push(`${v.name} robbed the settlement and fled`);
      log(s, `${v.name} slipped out in the night with ${describeItems(taken)}.`, 'bad');
      return null;
    },
  },
  {
    id: 'trader',
    title: 'Trader',
    adverse: false,
    cooldown: 36 * H,
    max: 3,
    prereq: (s) => dayOf(s.minute) >= 2 && s.weather.kind !== 'storm' && !climaxSoon(s, 10),
    weight: (s) => (isActive(s, 'collapse') ? 1.6 : 0.7),
    strike: (s) => {
      const offers: { id: string; give: Items; get: Items }[] = [
        { id: 'scrapMech', give: { scrap: 6 }, get: { mech: 2 } },
        { id: 'foodFuel', give: { food: 3 }, get: { fuel: 4 } },
        { id: 'waterMeds', give: { water: 12 }, get: { meds: 1 } },
        { id: 'fuelFood', give: { fuel: 3 }, get: { food: 5 } },
      ];
      const pick = offers.sort(() => nextRandom(s) - 0.5).slice(0, 3);
      return {
        id: 'trader',
        title: 'A trader’s cart',
        body: 'A woman with a mule cart and a shotgun across her knees stops at the gate. “Fair trades only. One deal, then I’m moving on.”',
        choices: [
          ...pick.map((o) => ({ id: o.id, label: `${describeItems(o.give)} → ${describeItems(o.get)}`, detail: 'One trade.', available: Object.entries(o.give).every(([k, v]) => count(s, k as never) >= (v ?? 0)), reason: `Needs ${describeItems(o.give)}` })),
          { id: 'none', label: 'No deal', detail: '', available: true },
        ],
        context: { offers: JSON.stringify(pick) },
      };
    },
    resolve: (s, id, ev) => {
      const offers = JSON.parse(ev.context.offers) as { id: string; give: Items; get: Items }[];
      const o = offers.find((x) => x.id === id);
      if (!o) return 'The trader moves on.';
      consume(s, o.give);
      produce(s, o.get);
      contact(s, 0.1);
      return `Traded ${describeItems(o.give)} for ${describeItems(o.get)}.`;
    },
  },
  {
    id: 'supplyDrop',
    title: 'Relief broadcast',
    adverse: false,
    cooldown: 60 * H,
    max: 1,
    prereq: (s) => dayOf(s.minute) >= 3 && s.objects.some((o) => o.type === 'radio' && o.state === 'operational' && o.powered),
    weight: () => 1.2,
    strike: (s) => {
      const loot = s.locations.garage.loot;
      loot.fuel = (loot.fuel ?? 0) + 6;
      loot.meds = (loot.meds ?? 0) + 2;
      loot.food = (loot.food ?? 0) + 6;
      s.world.hazards.garage = { risk: 1.3, note: 'Others heard the broadcast too', until: s.minute + 24 * H };
      log(s, 'Radio: “Relief supplies have been left at Hollis Auto Garage.” Fuel, food and medicine — if you get there first.', 'good');
      return null;
    },
  },
];

function defenseValue(s: GameState): number {
  return defense(s).value;
}

export function directorEvent(id: string): DirectorEvent | undefined {
  return DIRECTOR_EVENTS.find((e) => e.id === id);
}

/** EventDef adapters so director decisions resolve through the normal event path. */
export function directorEventDefs(): EventDef[] {
  return DIRECTOR_EVENTS.filter((e) => e.resolve).map((e) => ({ id: e.id, when: () => false, fire: () => null, resolve: e.resolve }));
}

function record(s: GameState, e: DirectorEvent): void {
  const d = s.world.director;
  d.counts[e.id] = (d.counts[e.id] ?? 0) + 1;
  d.last[e.id] = s.minute;
  d.lastAny = s.minute;
  if (e.adverse) d.lastAdverse = s.minute;
}

/** Start an event now: either its warning (strike scheduled later) or the strike itself. */
export function startEvent(s: GameState, e: DirectorEvent, force = false): boolean {
  let data: Record<string, string | number> = {};
  if (e.warn?.prepare) {
    const p = e.warn.prepare(s);
    if (!p) return false;
    data = p;
  }
  record(s, e);
  if (e.warn && !force) {
    log(s, e.warn.text(s, data), 'warn');
    s.world.director.pending.push({ id: e.id, at: s.minute + e.warn.delay, data });
    return true;
  }
  const ev = e.strike(s, data);
  if (ev) s.events.pending = ev;
  return true;
}

/** Hourly: fire due follow-ups, then maybe start something new. */
export function tickDirector(s: GameState): void {
  const d = s.world.director;
  // Due warnings strike now — unless the player dealt with the cause.
  for (const p of [...d.pending]) {
    if (p.at > s.minute || s.events.pending) continue;
    d.pending = d.pending.filter((x) => x !== p);
    const e = directorEvent(p.id);
    if (!e) continue;
    if (e.stillValid && !e.stillValid(s, p.data)) {
      if (e.averted) log(s, e.averted, 'good');
      continue;
    }
    const ev = e.strike(s, p.data);
    if (ev) {
      s.events.pending = ev;
      return;
    }
  }
  if (s.minute % 60 !== 30 || s.events.pending || s.result) return;
  if (s.minute - d.lastAny < 4 * H) return;
  const m = mods(s);
  const p = 0.09 * d.intensity;
  if (!chance(s, p)) return;
  const struggling = aliveSurvivors(s).length < 4 || presentSurvivors(s).filter((x) => x.health < 40).length >= 2;
  const rested = s.minute - d.lastAdverse >= 14 * H;
  const cands = DIRECTOR_EVENTS.filter((e) => {
    if ((d.counts[e.id] ?? 0) >= e.max) return false;
    if (s.minute - (d.last[e.id] ?? -1e9) < e.cooldown) return false;
    if (d.pending.some((x) => x.id === e.id)) return false;
    if (e.adverse && !rested) return false;
    return e.prereq(s);
  });
  if (!cands.length) return;
  const weights = cands.map((e) => e.weight(s) * (e.adverse ? m.adverse * (struggling ? 0.3 : 1) : m.opportunity * (struggling ? 1.5 : 1)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return;
  let r = nextRandom(s) * total;
  for (let i = 0; i < cands.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      startEvent(s, cands[i]);
      return;
    }
  }
}

