import { OBJECT_DEFS, objectName } from './actions';
import { describeItems, hasItems } from './items';
import { canAfford, consume, consumeUpTo, count, log, produce } from './inventory';
import { locationDecision, LOCATIONS, resolveLocationDecision } from './expeditions';
import { getSurvivor } from './jobs';
import { JOINER, makeSurvivor } from './setup';
import { first, presentSurvivors } from './survivors';
import { clockString, dayOf, MINUTES_PER_DAY } from './time';
import { isSheltered } from './world';
import type { EventChoice, GameState, Items, PendingEvent } from './types';
import { hashNoise } from './rng';

// Conditional events: each inspects simulation state, and either applies
// consequences directly (log-only) or raises a decision that pauses time.

interface EventDef {
  id: string;
  /** Minutes between repeats; omitted = fires once. */
  cooldown?: number;
  when: (s: GameState) => boolean;
  fire: (s: GameState) => PendingEvent | null;
  resolve?: (s: GameState, choiceId: string, ev: PendingEvent) => string;
}

const at = (day: number, hour: number, min = 0) => (day - 1) * MINUTES_PER_DAY + hour * 60 + min;

export function kesslerArrival(s: GameState): number {
  return at(3, 11) + Math.floor(hashNoise(s.seed, 23) * 4) * 60;
}

function ask(s: GameState): Items {
  if (count(s, 'water') >= 30) return { water: 12 };
  if (count(s, 'food') >= 8) return { food: 4 };
  if (count(s, 'food') >= 3) return { food: 2, water: Math.min(6, Math.floor(count(s, 'water'))) };
  return { water: Math.min(8, Math.floor(count(s, 'water'))) };
}

function choice(id: string, label: string, detail: string, cost: Items | null, s: GameState, extra?: string | null): EventChoice {
  const affordable = !cost || canAfford(s, cost);
  const reason = !affordable ? `Needs ${describeItems(cost!)}` : (extra ?? undefined);
  return { id, label, detail, available: affordable && !extra, reason };
}

function stormVulnerable(s: GameState) {
  return s.objects.filter(
    (o) =>
      OBJECT_DEFS[o.type].stormVulnerable &&
      !o.reinforced &&
      !isSheltered(o.x, o.y) &&
      ['operational', 'growing', 'ready', 'broken', 'damaged'].includes(o.state) &&
      !(o.type === 'planter' && o.state === 'damaged'),
  );
}

export const EVENTS: EventDef[] = [
  {
    id: 'intro',
    when: () => true,
    fire: () => ({
      id: 'intro',
      title: 'Day 1 — The Compound',
      body:
        'Six of you made it to the old Brannock Tool & Die compound. The fence still stands. The generator is seized, the well pump is dead, and there is food for two days and water for one.\n\nAn old trucker on the road said a big storm comes off the plains every autumn. Make this place work, and keep everyone alive for seven days.',
      choices: [{ id: 'begin', label: 'Get to work', detail: '', available: true }],
      context: {},
    }),
    resolve: () => 'The work begins.',
  },
  {
    id: 'stormRumour',
    when: (s) => s.minute >= at(2, 9),
    fire: (s) => {
      log(s, 'The western sky is bruised purple at dawn. A big storm is coming — in a few days, maybe sooner.', 'warn');
      return null;
    },
  },
  {
    id: 'radioForecast',
    when: (s) => !s.weather.stormForecastKnown && s.objects.some((o) => o.type === 'radio' && o.state === 'operational' && o.powered),
    fire: (s) => {
      s.weather.stormForecastKnown = true;
      log(s, `Radio bulletin: a severe storm will reach the region Day ${dayOf(s.weather.stormStart)} around ${clockString(s.weather.stormStart)}. Secure exposed equipment.`, 'warn');
      return null;
    },
  },
  {
    id: 'barometer',
    when: (s) => s.minute >= s.weather.stormStart - 30 * 60,
    fire: (s) => {
      const known = s.weather.stormForecastKnown;
      s.weather.stormForecastKnown = true;
      log(s, known ? 'The barometer is falling fast. The storm is on schedule.' : `The barometer is plunging. The storm will hit within ${Math.round((s.weather.stormStart - s.minute) / 60)} hours.`, 'warn');
      return null;
    },
  },
  {
    id: 'kesslerArrive',
    when: (s) => s.minute >= kesslerArrival(s) && s.weather.kind !== 'storm',
    fire: (s) => {
      const want = ask(s);
      const raided = !!s.flags.raidedCache;
      const note = !!s.flags.leftNote;
      s.flags.visitors = s.minute + 90;
      s.flags.kesslerAsk = JSON.stringify(want);
      const give: Items = raided ? { elec: 1, fuel: 2 } : { elec: 2, fuel: 4 };
      const hasRadio = s.objects.some((o) => o.type === 'radio' && o.state === 'operational');
      const amara = presentSurvivors(s).find((x) => x.trait === 'empath');
      const canTalk = hasRadio || (amara && amara.morale >= 40);
      let body =
        'Three people wait at the gate with a handcart: a grey-haired woman, a teenage girl, and a wiry man with grease to the elbows. “Marta Kessler,” the woman says. “We’re walking north ahead of the weather. ';
      body += `We need ${describeItems(want)}. We can pay in parts and fuel — or not at all, if you can spare it.”`;
      if (raided) body += '\n\nThe girl stares at your crates. “That’s our stockroom food,” she whispers. Marta’s jaw tightens; her price has gone up.';
      else if (note) body += '\n\n“You left the note at the market,” Marta says, softening. “Not many would have.”';
      return {
        id: 'kesslerArrive',
        title: 'Travellers at the gate',
        body,
        choices: [
          choice('trade', 'Trade', `Give ${describeItems(want)}; receive ${describeItems(give)}.`, want, s),
          choice('help', 'Give it freely', `Give ${describeItems(want)}. They won’t forget it.`, want, s),
          choice(
            'talk',
            'Share a meal and trade news',
            `Give 1 food. Learn what they know about the storm and the region (+2 mech).`,
            { food: 1 },
            s,
            canTalk ? null : 'Needs a working radio or a calm voice (Amara with decent morale)',
          ),
          { id: 'refuse', label: 'Turn them away', detail: 'Keep everything. Close the gate.', available: true },
        ],
        context: { give: JSON.stringify(give) },
      };
    },
    resolve: (s, id, ev) => {
      const want = JSON.parse(String(s.flags.kesslerAsk ?? '{}')) as Items;
      const give = JSON.parse(ev.context.give ?? '{}') as Items;
      if ((id === 'trade' || id === 'help') && !hasItems(s.inventory, want)) id = 'refuse';
      s.stats.choices.push(
        { trade: 'Traded with the Kesslers', help: 'Gave the Kesslers supplies freely', talk: 'Shared a meal and news with the Kesslers', refuse: 'Turned the Kesslers away' }[id] ?? id,
      );
      s.flags.kesslerChoice = id;
      switch (id) {
        case 'trade':
          consume(s, want);
          produce(s, give);
          s.trust.kessler += 10;
          return `Traded ${describeItems(want)} for ${describeItems(give)}. Marta nods: fair is fair.`;
        case 'help':
          consume(s, want);
          s.trust.kessler += 35;
          for (const x of presentSurvivors(s)) x.morale = Math.min(100, x.morale + 6);
          return 'Marta grips your hand. “We won’t forget this.” The group feels good about it.';
        case 'talk':
          consume(s, { food: 1 });
          produce(s, { mech: 2 });
          s.trust.kessler += 15;
          s.weather.stormForecastKnown = true;
          return `Over a shared meal Pavel sketches the storm track: it hits Day ${dayOf(s.weather.stormStart)} around ${clockString(s.weather.stormStart)}. He leaves you two bearings he won’t need.`;
        case 'refuse':
        default:
          s.trust.kessler -= 25;
          for (const x of presentSurvivors(s)) if (x.trait === 'empath') x.morale = Math.max(0, x.morale - 10);
          return 'You close the gate. The handcart rattles off down the road. The girl looks back twice.';
      }
    },
  },
  {
    id: 'kesslerJoin',
    when: (s) => !!s.events.fired.kesslerArrive && s.trust.kessler >= 25 && s.minute >= at(5, 8),
    fire: () => ({
      id: 'kesslerJoin',
      title: 'Pavel comes back',
      body:
        'Pavel Kessler is at the gate at first light, alone, a toolbag over his shoulder. “Marta and the girl are safe with cousins up north. She said you were good people. I’m a fair mechanic. I could stay — if you’ll have another mouth before the storm.”',
      choices: [
        { id: 'welcome', label: 'Welcome him', detail: 'Pavel joins: skilled mechanic, steady hands. Brings 1 tool kit and 2 mech parts. One more to feed.', available: true },
        { id: 'decline', label: 'Thank him, but no', detail: 'He leaves the parts anyway (+2 mech) and goes north.', available: true },
      ],
      context: {},
    }),
    resolve: (s, id) => {
      if (id === 'welcome') {
        const p = makeSurvivor(JOINER, dayOf(s.minute));
        s.survivors.push(p);
        produce(s, { tools: 1, mech: 2 });
        s.stats.choices.push('Took in Pavel Kessler');
        return 'Pavel drops his bag in the bunkhouse and asks where the generator is.';
      }
      produce(s, { mech: 2 });
      s.stats.choices.push('Declined Pavel’s offer to stay');
      return 'Pavel shrugs, leaves two bearings on the gatepost, and walks north.';
    },
  },
  {
    id: 'kesslerGift',
    when: (s) => !!s.events.fired.kesslerArrive && s.trust.kessler >= 5 && s.trust.kessler < 25 && s.minute >= at(6, 14) && s.weather.kind !== 'storm',
    fire: (s) => {
      produce(s, { food: 3, meds: 1 });
      log(s, 'A crate waits outside the gate with a note: “For the storm. — M.K.” (+3 food, +1 meds)', 'good');
      return null;
    },
  },
  {
    id: 'kesslerRaid',
    when: (s) => !!s.events.fired.kesslerArrive && s.trust.kessler < 0 && s.minute >= at(6, 2),
    fire: (s) => {
      const gate = s.objects.find((o) => o.type === 'gate');
      if (gate && gate.state === 'operational') {
        log(s, 'Torchlight at the gate in the small hours. Finding it chained, the figures melt back into the dark.', 'good');
        s.stats.choices.push('Locked gate turned away night raiders');
        return null;
      }
      const fuel = consumeUpTo(s, 'fuel', Math.floor(count(s, 'fuel') * 0.4));
      const food = consumeUpTo(s, 'food', Math.floor(count(s, 'food') * 0.3));
      log(s, `Night raiders slipped through the broken gate and took ${describeItems({ fuel, food })}.`, 'bad');
      s.stats.choices.push(`Raiders stole ${describeItems({ fuel, food })} through the broken gate`);
      for (const x of presentSurvivors(s)) x.morale = Math.max(0, x.morale - 10);
      return null;
    },
  },
  {
    id: 'stormArrive',
    when: (s) => s.minute >= s.weather.stormStart,
    fire: (s) => {
      const exposed = stormVulnerable(s);
      const list = exposed.length ? exposed.map((o) => objectName(o)).join(', ') : 'nothing — everything vulnerable is braced';
      const away = s.expeditions.filter((e) => e.phase !== 'done').length;
      return {
        id: 'stormArrive',
        title: 'The storm hits',
        body: `The light goes green, then black. Rain comes sideways. Everyone runs for cover.\n\nExposed and unbraced: ${list}.${away ? `\n\n${away} expedition team${away > 1 ? 's are' : ' is'} still out there and will shelter where they are.` : ''}`,
        choices: [{ id: 'brace', label: 'Hold on', detail: '', available: true }],
        context: {},
      };
    },
    resolve: () => 'The storm is overhead.',
  },
  {
    id: 'stormPeak',
    when: (s) => s.minute >= s.weather.stormStart + 5 * 60,
    fire: (s) => {
      const damage: string[] = [];
      for (const o of stormVulnerable(s)) {
        const name = objectName(o);
        switch (o.type) {
          case 'generator':
            o.condition = Math.max(0, o.condition - 45);
            if (o.state === 'operational') {
              o.state = 'flooded';
              o.issues = ['Flooded intake', 'Shorted wiring'];
              o.data.running = 0;
              damage.push(`${name} flooded`);
            }
            break;
          case 'waterPump':
            if (o.state === 'operational') {
              o.state = 'flooded';
              o.issues = ['Flooded motor'];
              damage.push(`${name} flooded`);
            }
            break;
          case 'batteryBank':
            if (o.state === 'operational') {
              o.state = 'damaged';
              o.issues = ['Water in the cells shorted two of them'];
              s.power.stored = 0;
              damage.push(`${name} shorted`);
            }
            break;
          case 'waterTank':
            if (o.state === 'operational') {
              o.state = 'damaged';
              o.issues = ['Torn loose; seam split'];
              damage.push(`${name} split`);
            }
            break;
          case 'planter':
            if (o.state === 'growing' || o.state === 'ready') {
              o.state = 'damaged';
              o.data.growth = 0;
              o.issues = ['Crop flattened by the storm'];
              damage.push('a planter’s crop flattened');
            }
            break;
          case 'windTurbine':
            if (o.state === 'operational') {
              o.state = 'broken';
              o.issues = ['Blades torn off'];
              damage.push(`${name} torn apart`);
            }
            break;
          case 'rainCatcher':
            if (o.state === 'operational') {
              o.state = 'dismantled';
              damage.push(`${name} blown away`);
            }
            break;
          case 'lamp':
            if (o.state === 'operational') {
              o.state = 'broken';
              o.issues = ['Lamp head smashed'];
              damage.push(`${name} smashed`);
            }
            break;
          case 'gate':
            if (o.state === 'operational') {
              o.state = 'damaged';
              o.issues = ['Wrenched off its hinges'];
              damage.push(`${name} wrenched loose`);
            }
            break;
        }
      }
      // Expedition teams caught outside suffer.
      for (const e of s.expeditions) {
        if (e.phase === 'done') continue;
        for (const id of e.members) {
          const m = getSurvivor(s, id);
          if (m && m.alive) {
            m.health = Math.max(5, m.health - 12);
            m.energy = Math.max(0, m.energy - 20);
          }
        }
        damage.push(`the ${LOCATIONS[e.destination].name} team spent the storm in a ditch`);
      }
      s.stats.stormDamage = damage;
      if (damage.length) log(s, `Storm damage: ${damage.join('; ')}.`, 'bad');
      else log(s, 'The storm howls at its peak — but everything holds.', 'good');
      return null;
    },
  },
  {
    id: 'stormEnd',
    when: (s) => s.minute >= s.weather.stormEnd,
    fire: (s) => {
      s.weather.stormResolved = true;
      const dmg = s.stats.stormDamage;
      return {
        id: 'stormEnd',
        title: 'After the storm',
        body: dmg.length
          ? `Grey morning. Water stands in the yard. The damage: ${dmg.join('; ')}.\n\nWhat broke can be fixed — if you have the parts.`
          : 'Grey morning. Water stands in the yard, the tanks are brimming, and every brace held. The group walks the fence line grinning.',
        choices: [{ id: 'ok', label: 'Assess the damage', detail: '', available: true }],
        context: {},
      };
    },
    resolve: (s) => {
      if (!s.stats.stormDamage.length) for (const x of presentSurvivors(s)) x.morale = Math.min(100, x.morale + 10);
      return 'The clean-up begins.';
    },
  },
  {
    id: 'expeditionDecision',
    cooldown: 1,
    when: (s) => !!s.flags.pendingExpedition,
    fire: (s) => {
      const exp = s.expeditions.find((e) => e.id === s.flags.pendingExpedition);
      if (!exp) {
        delete s.flags.pendingExpedition;
        return null;
      }
      const d = locationDecision(s, exp);
      const team = exp.members.map((id) => first(getSurvivor(s, id)!)).join(', ');
      return {
        id: 'expeditionDecision',
        title: `${LOCATIONS[exp.destination].name}: ${d.title}`,
        body: `${team} report back.\n\n${d.body}`,
        choices: d.choices.map((c) => ({ ...c, available: true })),
        context: { exp: exp.id },
      };
    },
    resolve: (s, id, ev) => {
      const exp = s.expeditions.find((e) => e.id === ev.context.exp);
      if (!exp) return 'The team moved on.';
      return resolveLocationDecision(s, exp, id);
    },
  },
  {
    id: 'lowWater',
    cooldown: 8 * 60,
    when: (s) => count(s, 'water') < 8 && s.water.cleanIn <= 0 && s.minute > at(1, 9),
    fire: (s) => {
      log(s, `Drinking water is down to ${count(s, 'water').toFixed(0)} L and nothing is treating more.`, 'warn');
      return null;
    },
  },
  {
    id: 'lowFood',
    cooldown: 8 * 60,
    when: (s) => count(s, 'food') < 3,
    fire: (s) => {
      log(s, `Only ${count(s, 'food')} rations left.`, 'warn');
      return null;
    },
  },
  {
    id: 'powerDeficit',
    cooldown: 6 * 60,
    when: (s) => s.power.deficit,
    fire: (s) => {
      log(s, `Power shortfall: demand ${s.power.demand.toFixed(1)} kW exceeds supply. Lower-priority equipment shut off.`, 'warn');
      return null;
    },
  },
  {
    id: 'dawn',
    cooldown: MINUTES_PER_DAY - 1,
    when: (s) => s.minute % MINUTES_PER_DAY === 6 * 60 && dayOf(s.minute) > 1,
    fire: (s) => {
      log(s, `Day ${dayOf(s.minute)} dawns. ${presentSurvivors(s).length} at the compound.`, 'info');
      return null;
    },
  },
];

export function runEvents(state: GameState): void {
  if (state.events.pending) return;
  for (const ev of EVENTS) {
    const last = state.events.fired[ev.id];
    if (last !== undefined && (ev.cooldown === undefined || state.minute - last < ev.cooldown)) continue;
    if (!ev.when(state)) continue;
    state.events.fired[ev.id] = state.minute;
    const pending = ev.fire(state);
    if (pending) {
      state.events.pending = pending;
      return;
    }
  }
}

export function resolveEvent(state: GameState, choiceId: string): { ok: boolean; message: string } {
  const ev = state.events.pending;
  if (!ev) return { ok: false, message: 'Nothing to decide.' };
  const c = ev.choices.find((x) => x.id === choiceId);
  if (!c) return { ok: false, message: 'Unknown choice.' };
  if (!c.available) return { ok: false, message: c.reason ?? 'Not possible.' };
  const def = EVENTS.find((e) => e.id === ev.id);
  state.events.pending = null;
  const text = def?.resolve ? def.resolve(state, choiceId, ev) : '';
  if (text) log(state, text, 'info');
  return { ok: true, message: text };
}
