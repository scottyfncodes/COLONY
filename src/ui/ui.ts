import { BLUEPRINTS, OBJECT_DEFS, objectName, blueprint, type ActionDef } from '../sim/actions';
import { expeditionPlan, LOCATIONS, MAX_TEAM, validateExpedition, vehicleAvailable } from '../sim/expeditions';
import { GEN_OUTPUT, irrigated, BATTERY_CAPACITY } from '../sim/infrastructure';
import { cleanCapacity, count, rawCapacity, roomFor, storageCapacity } from '../sim/inventory';
import { ITEMS, describeItems, missingItems, solidCount } from '../sim/items';
import { actionBlocked, availableActions, getObject, getSurvivor, jobWaitingOn, workRate } from '../sim/jobs';
import { immediateObjective, objectives } from '../sim/scenario';
import { canToggle } from '../sim/sim';
import { TRAITS } from '../sim/setup';
import { presentSurvivors } from '../sim/survivors';
import { clockString, dayOf, formatDuration, isNight } from '../sim/time';
import type { Command, CommandResult, GameState, ItemId, Items, Job, LocationId, ObjectType, Survivor, WorldObject } from '../sim/types';
import type { ViewState } from '../render/renderer';
import type { SpeedIndex } from '../sim/time';
import { icon } from './icons';
import { portrait } from './portraits';

export type PanelKind = 'object' | 'survivor' | 'build' | 'jobs' | 'log' | 'stores' | null;
export type ModalKind = 'expedition' | 'menu' | 'objectives' | 'help' | 'end' | 'confirmNew' | null;

export interface Controller {
  state: GameState;
  view: ViewState;
  speed: SpeedIndex;
  panel: PanelKind;
  modal: ModalKind;
  placing: ObjectType | null;
  assignee: string | null;
  command(cmd: Command): CommandResult;
  setSpeed(i: SpeedIndex): void;
  selectSurvivor(id: string | null): void;
  selectObject(id: string | null): void;
  openPanel(p: PanelKind): void;
  openModal(m: ModalKind): void;
  startPlacing(t: ObjectType): void;
  confirmPlacing(): void;
  cancelPlacing(): void;
  centerOnSurvivor(id: string): void;
  centerOnObject(id: string): void;
  newGame(): void;
  saveStatus: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmt = (v: number, d = 0) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(d || 1));
const first = (s: Survivor) => s.name.split(' ')[0];

const ACTIVITY: Record<string, string> = {
  idle: 'Idle',
  walking: 'Walking',
  working: 'Working',
  eating: 'Eating',
  drinking: 'Drinking',
  sleeping: 'Asleep',
  hauling: 'Hauling',
  fetching: 'Fetching parts',
  sheltering: 'Sheltering',
  away: 'Away',
  dead: 'Dead',
};

const KIND_LABEL: Record<string, string> = {
  repair: 'Repair',
  dismantle: 'Dismantle',
  repurpose: 'Repurpose',
  salvage: 'Salvage',
  craft: 'Craft',
  reinforce: 'Reinforce',
  service: 'Maintain',
  clear: 'Prepare',
  plant: 'Plant',
  harvest: 'Harvest',
  water: 'Tend',
};

const SKILL_LABEL: Record<string, string> = {
  mechanical: 'Mechanical',
  electrical: 'Electrical',
  medical: 'Medical',
  construction: 'Construction',
  scavenging: 'Scavenging',
};

const STATE_TONE: Record<string, string> = {
  operational: 'good',
  growing: 'good',
  ready: 'good',
  laid: 'good',
  broken: 'bad',
  flooded: 'bad',
  damaged: 'warn',
  overgrown: 'warn',
  empty: 'neutral',
  site: 'neutral',
  stripped: 'neutral',
  pile: 'neutral',
  wreck: 'neutral',
  siphoned: 'neutral',
  intact: 'neutral',
};

function chip(id: ItemId, n: number, cls = ''): string {
  return `<span class="chip ${cls}">${icon(id)}<b>${fmt(n)}</b>${ITEMS[id].unit ? `<i>${ITEMS[id].unit}</i>` : ''}</span>`;
}

function costChips(state: GameState, items: Items, tools = false): string {
  const parts = (Object.keys(items) as ItemId[]).map((k) => {
    const need = items[k] ?? 0;
    const have = count(state, k);
    return `<span class="cost ${have + 1e-9 >= need ? '' : 'short'}" title="${esc(ITEMS[k].name)}">${icon(k)}${fmt(need)}<small>/${fmt(have)}</small></span>`;
  });
  if (tools) parts.push(`<span class="cost ${count(state, 'tools') >= 1 ? '' : 'short'}" title="Needs a free tool kit (returned after)">${icon('tools')}kit</span>`);
  return parts.join('') || '<span class="cost free">No materials</span>';
}

function bar(v: number, cls: string, label?: string): string {
  const w = Math.max(0, Math.min(100, v));
  return `<span class="bar ${cls}" ${label ? `title="${label}"` : ''}><span style="width:${w}%"></span></span>`;
}

function jobStatus(state: GameState, j: Job): string {
  const w = getSurvivor(state, j.assigneeId);
  const who = w ? first(w) : null;
  switch (j.phase) {
    case 'queued': {
      const wait = jobWaitingOn(state, j);
      if (wait) return `<span class="tone-warn">${esc(wait)}</span>`;
      if (j.preferredId && !who) return `Waiting for ${esc(first(getSurvivor(state, j.preferredId)!))}`;
      return who ? `${esc(who)} is starting` : 'Open — next free hand';
    }
    case 'fetch':
      return `${esc(who ?? '?')} is collecting materials`;
    case 'travel':
      return `${esc(who ?? '?')} is on the way`;
    case 'work':
      return `${esc(who ?? '?')} working · ${Math.floor((j.progress / j.required) * 100)}%`;
    case 'haul':
      return `${esc(who ?? '?')} hauling to storage`;
  }
}

function estimate(state: GameState, a: { minutes: number; skill: Job['skill']; kind: Job['kind'] }, preferred: string | null): string {
  const fake = { kind: a.kind, skill: a.skill, exposed: false, targetId: '' } as unknown as Job;
  const team = presentSurvivors(state);
  const cand = preferred ? team.filter((s) => s.id === preferred) : team;
  if (!cand.length) return formatDuration(a.minutes);
  let best = cand[0];
  let br = 0;
  for (const s of cand) {
    const r = workRate(state, s, fake);
    if (r > br) {
      br = r;
      best = s;
    }
  }
  return `~${formatDuration(a.minutes / br)} <small>(${esc(first(best))})</small>`;
}

export class UI {
  private els: Record<string, HTMLElement> = {};
  private cache = new Map<string, string>();
  private pointerDown = false;
  private toastTimer = 0;
  private exp: { dest: LocationId; members: string[]; packed: Items; vehicle: boolean } = { dest: 'market', members: [], packed: { water: 6 }, vehicle: false };
  private endShown = false;
  private sheet: HTMLDivElement | null = null;

  constructor(private root: HTMLElement, private c: Controller) {
    root.insertAdjacentHTML(
      'beforeend',
      `<div id="hud"><header id="top"><div id="clock"></div><div id="speed"></div><div id="res"></div></header>
       <div id="objective"></div>
       <div id="alerts"></div></div>
       <div id="bottom"><aside id="panel" class="hidden"></aside>
       <nav id="dock"></nav>
       <footer id="roster"></footer></div>
       <div id="toasts"></div>
       <div id="modal" class="hidden"></div>`,
    );
    for (const id of ['top', 'clock', 'res', 'speed', 'objective', 'alerts', 'panel', 'dock', 'roster', 'toasts', 'modal']) this.els[id] = document.getElementById(id)!;
    root.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('#top,#panel,#dock,#roster,#modal,#objective,#alerts')) this.pointerDown = true;
    });
    const up = () => (this.pointerDown = false);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('change', (e) => this.onChange(e));
  }

  toast(msg: string, ok = true): void {
    if (!msg) return;
    const t = this.els.toasts;
    const el = document.createElement('div');
    el.className = `toast ${ok ? '' : 'bad'}`;
    el.textContent = msg;
    t.appendChild(el);
    while (t.children.length > 3) t.firstChild!.remove();
    window.clearTimeout(this.toastTimer);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3200);
  }

  private set(id: string, html: string): void {
    if (this.cache.get(id) === html) return;
    this.cache.set(id, html);
    this.els[id].innerHTML = html;
  }

  private show(id: string, visible: boolean): void {
    this.els[id].classList.toggle('hidden', !visible);
  }

  update(force = false): void {
    if (this.pointerDown && !force) return;
    const s = this.c.state;
    this.set('clock', this.clockHtml(s));
    this.set('res', this.resHtml(s));
    this.set('speed', this.speedHtml());
    this.set('objective', this.objectiveHtml(s));
    this.set('alerts', this.alertsHtml(s));
    this.set('dock', this.dockHtml(s));
    this.set('roster', this.rosterHtml(s));
    const panel = this.panelHtml(s);
    this.show('panel', !!panel);
    this.root.classList.toggle('panel-open', !!panel);
    if (panel) this.set('panel', panel);
    // Modals: a pending event always takes precedence.
    let modal = '';
    if (s.events.pending) modal = this.eventHtml(s);
    else if (s.result && !this.endShown) {
      this.endShown = true;
      this.c.modal = 'end';
    }
    if (!modal) {
      switch (this.c.modal) {
        case 'expedition': modal = this.expeditionHtml(s); break;
        case 'menu': modal = this.menuHtml(); break;
        case 'objectives': modal = this.objectivesHtml(s); break;
        case 'help': modal = this.helpHtml(); break;
        case 'end': modal = this.endHtml(s); break;
        case 'confirmNew': modal = this.confirmNewHtml(); break;
      }
    }
    this.show('modal', !!modal);
    const kind = `sheet m-${s.events.pending ? `event ev-${s.events.pending.id}` : this.c.modal ?? ''}`;
    if (!this.sheet) {
      this.sheet = document.createElement('div');
      this.els.modal.appendChild(this.sheet);
    }
    if (modal) {
      // Keep the sheet element stable so its entrance animation only plays when the modal changes.
      if (this.sheet.className !== kind) {
        this.sheet.className = kind;
        this.sheet.scrollTop = 0;
      }
      if (this.cache.get('modal') !== modal) {
        this.cache.set('modal', modal);
        this.sheet.innerHTML = modal;
      }
    } else {
      this.cache.delete('modal');
      this.sheet.className = '';
    }
  }

  resetEnd(): void {
    this.endShown = false;
  }

  // ---------------------------------------------------------------- top bar

  private clockHtml(s: GameState): string {
    const night = isNight(s.minute);
    const wx = s.weather;
    const wxIcon = wx.kind === 'storm' ? 'storm' : wx.kind === 'rain' ? 'rain' : wx.kind === 'overcast' ? 'cloud' : night ? 'moon' : 'sun';
    const wxText = { storm: 'Storm', rain: 'Rain', overcast: 'Overcast', clear: night ? 'Night' : 'Clear' }[wx.kind];
    let storm = '';
    if (wx.kind === 'storm') storm = `<span class="storm live">${icon('storm')}Storm · ends in ${formatDuration(wx.stormEnd - s.minute)}</span>`;
    else if (!wx.stormResolved) {
      const left = wx.stormStart - s.minute;
      storm = wx.stormForecastKnown
        ? `<span class="storm ${left < 24 * 60 ? 'soon' : ''}">${icon('storm')}${formatDuration(left)}</span>`
        : `<span class="storm vague" title="Repair the radio for an exact forecast">${icon('storm')}${s.minute > 32 * 60 ? `~Day ${dayOf(wx.stormStart) - (s.seed % 2)}–${dayOf(wx.stormStart) + 1}` : 'coming'}</span>`;
    }
    return `<div class="day"><b>Day ${Math.min(7, dayOf(s.minute))}</b><span class="of">/7</span><span class="time">${clockString(s.minute)}</span></div>
      <div class="wx">${icon(wxIcon)}<span>${wxText}</span>${storm}</div>`;
  }

  private resHtml(s: GameState): string {
    const lowFood = count(s, 'food') < 4;
    const lowWater = count(s, 'water') < 10;
    const p = s.power;
    const gen = s.objects.find((o) => o.type === 'generator');
    const running = !!gen?.data.running;
    const powerTxt = p.supply > 0 || p.stored > 0 ? `${fmt(p.demand, 1)}/${fmt(p.supply + (p.stored > 0 ? 6 : 0), 1)}` : 'off';
    const rows = [
      chip('food', count(s, 'food'), lowFood ? 'low' : ''),
      chip('water', count(s, 'water'), lowWater ? 'low' : ''),
      chip('rawWater', count(s, 'rawWater')),
      chip('fuel', count(s, 'fuel'), count(s, 'fuel') < 2 ? 'low' : ''),
      `<span class="chip power ${p.deficit ? 'low' : running || p.supply > 0 ? 'on' : ''}" title="Power demand / supply (kW)">${icon('power')}<b>${powerTxt}</b>${p.capacity ? `<i>${Math.round((p.stored / p.capacity) * 100)}%</i>` : ''}</span>`,
      chip('scrap', count(s, 'scrap')),
      chip('mech', count(s, 'mech')),
      chip('elec', count(s, 'elec')),
      chip('battery', count(s, 'battery')),
      chip('tools', count(s, 'tools'), count(s, 'tools') < 1 ? 'low' : ''),
      chip('meds', count(s, 'meds')),
    ];
    if (count(s, 'engine')) rows.push(chip('engine', count(s, 'engine'), 'special'));
    if (count(s, 'filter')) rows.push(chip('filter', count(s, 'filter'), 'special'));
    return `<button class="res-btn" data-a="panel" data-v="stores" aria-label="Stores and systems">${rows.join('')}</button>`;
  }

  private speedHtml(): string {
    const btn = (i: SpeedIndex, ic: string, label: string) => `<button class="${this.c.speed === i ? 'on' : ''}" data-a="speed" data-v="${i}" aria-label="${label}">${icon(ic)}</button>`;
    return `${btn(0, 'pause', 'Pause')}${btn(1, 'play', 'Normal speed')}${btn(2, 'ff', 'Fast')}${btn(3, 'fff', 'Fastest')}<button class="menu" data-a="modal" data-v="menu" aria-label="Menu">${icon('menu')}</button>`;
  }

  private objectiveHtml(s: GameState): string {
    const objs = objectives(s).filter((o) => !o.optional);
    const done = objs.filter((o) => o.done).length;
    return `<button data-a="modal" data-v="objectives">${icon('target')}<span class="obj-text">${esc(immediateObjective(s))}</span><span class="obj-count">${done}/${objs.length}</span></button>`;
  }

  private alertsHtml(s: GameState): string {
    const out: string[] = [];
    const idle = presentSurvivors(s).filter((x) => x.activity === 'idle' && !x.jobId && !x.moveTarget);
    if (idle.length && !s.events.pending) out.push(`<button class="alert" data-a="sel-surv" data-v="${idle[0].id}">${icon('person')}${idle.length} idle</button>`);
    const blocked = s.jobs.filter((j) => j.phase === 'queued' && jobWaitingOn(s, j));
    if (blocked.length) out.push(`<button class="alert warn" data-a="panel" data-v="jobs">${icon('jobs')}${blocked.length} waiting on parts</button>`);
    const sick = presentSurvivors(s).filter((x) => x.sick > 0 || x.injury > 40 || x.health < 40);
    if (sick.length) out.push(`<button class="alert bad" data-a="sel-surv" data-v="${sick[0].id}">${icon('heart')}${sick.length} need care</button>`);
    if (s.power.deficit) out.push(`<button class="alert bad" data-a="panel" data-v="stores">${icon('power')}Power short</button>`);
    if (roomFor(s, 'scrap') < 5) out.push(`<button class="alert warn" data-a="panel" data-v="stores">${icon('stores')}Storage full</button>`);
    const away = s.expeditions.filter((e) => e.phase !== 'done');
    if (away.length) out.push(`<button class="alert info" data-a="expedition">${icon('map')}${away.length} team${away.length > 1 ? 's' : ''} out</button>`);
    if (s.result) out.push(`<button class="alert good" data-a="modal" data-v="end">${icon('check')}Scenario complete — results</button>`);
    return out.join('');
  }

  private dockHtml(s: GameState): string {
    const p = this.c.panel;
    const jobs = s.jobs.length;
    const away = s.expeditions.filter((e) => e.phase !== 'done').length;
    const b = (a: string, v: string, ic: string, label: string, on: boolean, badge = '') =>
      `<button class="${on ? 'on' : ''}" data-a="${a}" data-v="${v}">${icon(ic)}<span>${label}</span>${badge ? `<em>${badge}</em>` : ''}</button>`;
    return [
      b('panel', 'build', 'build', 'Build', p === 'build' || !!this.c.placing),
      b('panel', 'jobs', 'jobs', 'Jobs', p === 'jobs', jobs ? String(jobs) : ''),
      b('expedition', '', 'map', 'Expedition', this.c.modal === 'expedition', away ? String(away) : ''),
      b('panel', 'log', 'log', 'Log', p === 'log'),
    ].join('');
  }

  private rosterHtml(s: GameState): string {
    return s.survivors
      .map((x) => {
        const sel = this.c.view.selectedSurvivor === x.id;
        const status = x.alive ? (x.away ? 'Away' : ACTIVITY[x.activity] ?? x.activity) : 'Dead';
        const crit = x.alive && (x.thirst < 15 || x.hunger < 15 || x.health < 35 || x.sick > 0 || x.injury > 40);
        return `<button class="surv ${sel ? 'sel' : ''} ${x.alive ? '' : 'dead'} ${x.away ? 'away' : ''} ${crit ? 'crit' : ''}" data-a="sel-surv" data-v="${x.id}">
          <img src="${portrait(x)}" alt="">
          <span class="nm">${esc(first(x))}</span>
          <span class="st">${esc(status)}</span>
          <span class="bars">${bar(x.health, 'hp', 'Health')}${bar(x.thirst, 'th', 'Hydration')}${bar(x.hunger, 'fd', 'Fed')}${bar(x.energy, 'en', 'Energy')}</span>
        </button>`;
      })
      .join('');
  }

  // ---------------------------------------------------------------- panels

  private panelHtml(s: GameState): string {
    if (this.c.placing) return this.placingHtml(s);
    switch (this.c.panel) {
      case 'object': {
        const o = this.c.view.selectedObject ? getObject(s, this.c.view.selectedObject) : undefined;
        return o ? this.objectHtml(s, o) : '';
      }
      case 'survivor': {
        const x = getSurvivor(s, this.c.view.selectedSurvivor);
        return x ? this.survivorHtml(s, x) : '';
      }
      case 'build': return this.buildHtml(s);
      case 'jobs': return this.jobsHtml(s);
      case 'log': return this.logHtml(s);
      case 'stores': return this.storesHtml(s);
      default: return '';
    }
  }

  private head(title: string, sub = '', pill = ''): string {
    return `<div class="ph"><div><h2>${title}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}</div>${pill}<button class="x" data-a="close-panel" aria-label="Close">${icon('close')}</button></div>`;
  }

  private assigneeSelect(s: GameState, jobId?: string, current?: string | null): string {
    const opts = [`<option value="">Anyone (auto)</option>`]
      .concat(
        presentSurvivors(s).map((x) => `<option value="${x.id}" ${current === x.id ? 'selected' : ''}>${esc(first(x))} · ${x.role}${x.jobId && x.jobId !== jobId ? ' (busy)' : ''}</option>`),
      )
      .join('');
    return jobId
      ? `<select data-a="assign" data-v="${jobId}" aria-label="Worker">${opts}</select>`
      : `<select data-a="set-assignee" aria-label="Worker for new jobs">${opts}</select>`;
  }

  private objectStats(s: GameState, o: WorldObject): string {
    const rows: [string, string][] = [];
    const p = s.power;
    switch (o.type) {
      case 'generator':
        rows.push(['Condition', `${bar(o.condition, o.condition < 40 ? 'hp' : 'en')} ${Math.round(o.condition)}%`]);
        if (o.state === 'operational') {
          rows.push(['Status', o.on ? (o.data.running ? `<span class="tone-good">Running</span> · ${fmt(p.fuelBurn, 2)} L/h fuel` : p.capacity ? 'Standby (battery carrying load)' : 'Standby (no demand)') : 'Switched off']);
          rows.push(['Output', `${GEN_OUTPUT * (o.condition < 40 ? 0.7 : 1)} kW max${o.data.efficient ? ' · efficient engine' : ''}`]);
          rows.push(['Fuel', `${fmt(count(s, 'fuel'), 1)} L in store`]);
        }
        break;
      case 'batteryBank':
        if (o.state === 'operational') rows.push(['Stored', `${bar((p.stored / BATTERY_CAPACITY) * 100, 'en')} ${fmt(p.stored, 1)}/${BATTERY_CAPACITY} kWh`]);
        break;
      case 'waterPump':
        if (o.state === 'operational') rows.push(['Status', !o.on ? 'Switched off' : o.powered ? (count(s, 'rawWater') >= rawCapacity(s) - 0.1 ? 'Tank full — idle' : '<span class="tone-good">Pumping 30 L/h</span>') : '<span class="tone-bad">No power</span> — needs 1.5 kW']);
        break;
      case 'waterTank':
        rows.push(['Untreated', `${bar((count(s, 'rawWater') / rawCapacity(s)) * 100, 'th')} ${fmt(count(s, 'rawWater'))}/${rawCapacity(s)} L`]);
        break;
      case 'sandFilter':
      case 'purifier':
        rows.push(['Treating', count(s, 'rawWater') > 0.1 ? `${o.type === 'purifier' ? (o.powered ? '15 L/h' : '<span class="tone-bad">No power</span>') : o.data.cartridge ? '10 L/h' : '5 L/h'}` : '<span class="tone-warn">No untreated water</span>']);
        rows.push(['Clean store', `${fmt(count(s, 'water'))}/${cleanCapacity(s)} L`]);
        break;
      case 'planter':
        if (o.state === 'growing' || o.state === 'ready') {
          rows.push(['Growth', `${bar(o.data.growth ?? 0, 'fd')} ${Math.floor(o.data.growth ?? 0)}%`]);
          rows.push(['Moisture', `${bar(o.data.moisture ?? 0, 'th')} ${irrigated(s) ? 'irrigated' : (o.data.moisture ?? 0) < 25 ? '<span class="tone-warn">dry</span>' : ''}`]);
        }
        break;
      case 'windTurbine':
        if (o.state === 'operational') rows.push(['Output', `${fmt(Math.min(3, 2.6 * s.weather.wind), 1)} kW (wind ${Math.round(s.weather.wind * 100)}%)`]);
        break;
      case 'workbench':
        if (o.state === 'operational') rows.push(['Power', o.powered ? '<span class="tone-good">Powered</span> — full speed' : 'Unpowered — crafting at 60% speed']);
        break;
      case 'radio':
        if (o.state === 'operational') rows.push(['Forecast', s.weather.stormForecastKnown ? `Storm Day ${dayOf(s.weather.stormStart)} ~${clockString(s.weather.stormStart)}` : o.powered ? 'Listening…' : 'Needs power']);
        break;
      case 'depot':
        rows.push(['Storage', `${fmt(solidCount(s.inventory))}/${storageCapacity(s)} items`]);
        rows.push(['Water', `${fmt(count(s, 'water'))}/${cleanCapacity(s)} L clean`]);
        break;
      case 'scrapPile':
      case 'crate':
      case 'drums':
        if (o.state === 'pile') rows.push(['Looks like', o.type === 'scrapPile' ? 'scrap and maybe parts' : describeItems(o.contents)]);
        break;
      case 'gate':
        rows.push(['Security', o.state === 'operational' ? '<span class="tone-good">Secured</span>' : '<span class="tone-warn">Anyone can walk in</span>']);
        break;
      case 'forklift':
        if (o.state === 'operational') rows.push(['Vehicle', o.data.away ? 'Out on an expedition' : 'Ready for expeditions']);
        break;
    }
    if (OBJECT_DEFS[o.type].stormVulnerable && !['dismantled', 'site'].includes(o.state)) rows.push(['Storm', o.reinforced ? `${icon('shield')} Reinforced` : '<span class="tone-warn">Exposed</span>']);
    return rows.length ? `<dl class="stats">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : '';
  }

  private actionCard(s: GameState, o: WorldObject, a: ActionDef): string {
    const inputs = a.inputs(s, o);
    const outputs = a.outputs ? a.outputs(s, o) : {};
    const why = actionBlocked(s, o, a);
    const missing = missingItems(s.inventory, inputs);
    const short = Object.keys(missing).length > 0 || (a.tools && count(s, 'tools') < 1);
    const warn = a.warning?.(s, o);
    const who = this.c.assignee ? getSurvivor(s, this.c.assignee) : null;
    const outTxt = Object.keys(outputs).length ? `<div class="yield">${icon('check')}Yields ${o.type === 'scrapPile' ? 'its contents' : esc(describeItems(outputs))}</div>` : '';
    return `<div class="act ${a.kind}">
      <div class="act-h"><span class="kind">${KIND_LABEL[a.kind] ?? a.kind}</span><b>${esc(a.label)}</b></div>
      <p>${esc(a.result(s, o))}</p>
      ${outTxt}
      <div class="costs">${costChips(s, inputs, a.tools)}</div>
      <div class="meta">${icon('clock')}${estimate(s, a, this.c.assignee)}${a.skill ? ` · ${SKILL_LABEL[a.skill]}` : ''}</div>
      ${warn ? `<div class="warnline">${icon('warn')}${esc(warn)}</div>` : ''}
      <button class="go" data-a="queue" data-v="${o.id}|${a.id}" ${why ? 'disabled' : ''}>${why ? esc(why) : `${who ? `Assign ${esc(first(who))}` : 'Queue job'}${short ? ' · waits for parts' : ''}`}</button>
    </div>`;
  }

  private objectHtml(s: GameState, o: WorldObject): string {
    const st = o.state === 'site' ? 'construction' : o.state;
    const pill = `<span class="pill ${STATE_TONE[o.state] ?? 'neutral'}">${esc(st)}</span>`;
    const name = o.state === 'site' ? `${blueprint(o.label as ObjectType)?.name ?? 'Site'} (site)` : objectName(o);
    let html = this.head(esc(name), esc(OBJECT_DEFS[o.type].blurb), pill);
    html += this.objectStats(s, o);
    if (o.issues.length) html += `<ul class="issues">${o.issues.map((i) => `<li>${icon('warn')}${esc(i)}</li>`).join('')}</ul>`;
    if (canToggle(o)) html += `<button class="toggle ${o.on ? 'on' : ''}" data-a="toggle" data-v="${o.id}">${icon('power')}${o.on ? 'Switched on — tap to switch off' : 'Switched off — tap to switch on'}</button>`;
    const jobs = s.jobs.filter((j) => j.targetId === o.id);
    for (const j of jobs) {
      html += `<div class="jobcard"><div class="jt">${esc(j.label)}</div><div class="js">${jobStatus(s, j)}</div>
        <div class="bar wide"><span style="width:${Math.floor((j.progress / j.required) * 100)}%"></span></div>
        <div class="row">${this.assigneeSelect(s, j.id, j.preferredId ?? j.assigneeId)}<button class="ghost" data-a="cancel" data-v="${j.id}">Cancel</button></div></div>`;
    }
    const acts = availableActions(s, o);
    if (acts.length && !jobs.length) {
      html += `<div class="assign">${icon('person')}Worker ${this.assigneeSelect(s, undefined, this.c.assignee)}</div>`;
      html += `<div class="acts">${acts.map((a) => this.actionCard(s, o, a)).join('')}</div>`;
    } else if (!acts.length && !jobs.length && o.state !== 'site') {
      html += `<p class="muted">Nothing more to do here right now.</p>`;
    }
    return html;
  }

  private survivorHtml(s: GameState, x: Survivor): string {
    const t = TRAITS[x.trait];
    const job = x.jobId ? s.jobs.find((j) => j.id === x.jobId) : undefined;
    const statLine = (label: string, v: number, cls: string, note = '') => `<div class="need"><span>${label}</span>${bar(v, cls)}<b>${Math.round(v)}</b>${note}</div>`;
    let html = `<div class="ph surv-h"><img src="${portrait(x)}" alt=""><div><h2>${esc(x.name)}</h2><p class="sub">${x.role} · <b>${t.name}</b> — ${esc(t.text)}</p></div><button class="x" data-a="close-panel" aria-label="Close">${icon('close')}</button></div>`;
    if (!x.alive) return html + `<p class="tone-bad">Died of ${esc(x.causeOfDeath ?? 'unknown causes')}.</p>`;
    html += `<div class="needs">
      ${statLine('Health', x.health, 'hp', x.sick > 0 ? '<em class="tag bad">sick</em>' : x.injury > 0 ? `<em class="tag warn">hurt ${Math.round(x.injury)}</em>` : '')}
      ${statLine('Hydration', x.thirst, 'th')}
      ${statLine('Fed', x.hunger, 'fd')}
      ${statLine('Energy', x.energy, 'en', x.sleptInBed ? '' : '<em class="tag warn">no bed</em>')}
      ${statLine('Morale', x.morale, 'mo')}
    </div>`;
    html += `<div class="doing">${icon(x.away ? 'map' : x.activity === 'sleeping' ? 'bed' : 'clock')}<span>${x.away ? 'On an expedition' : esc(ACTIVITY[x.activity] ?? x.activity)}${job ? ` — ${esc(job.label)}` : ''}</span></div>`;
    if (!x.away) {
      html += `<div class="row wrap">`;
      if (job) html += `<button class="ghost" data-a="stopjob" data-v="${x.id}">Stop job</button>`;
      if ((x.injury > 0 || x.sick > 0 || x.health < 80) && !s.jobs.some((j) => j.kind === 'treat' && j.targetId === x.id))
        html += `<button class="ghost" data-a="treat" data-v="${x.id}" ${count(s, 'meds') < 1 ? 'disabled' : ''}>${icon('meds')}Treat (1 meds)</button>`;
      html += `<button class="ghost ${x.autoWork ? 'on' : ''}" data-a="autowork" data-v="${x.id}">${x.autoWork ? 'Takes open jobs ✓' : 'Waits for orders'}</button>`;
      html += `<button class="ghost" data-a="center" data-v="${x.id}">${icon('center')}Find</button></div>`;
      html += `<p class="hint">Tap the ground to send ${esc(first(x))} somewhere, or tap a machine to give them a job.</p>`;
    }
    html += `<div class="skills">${(Object.keys(SKILL_LABEL) as (keyof typeof SKILL_LABEL)[])
      .map((k) => {
        const v = x.skills[k as keyof Survivor['skills']];
        return `<div><span>${SKILL_LABEL[k]}</span><span class="pips">${[1, 2, 3].map((i) => `<i class="${v >= i ? 'on' : ''}"></i>`).join('')}</span></div>`;
      })
      .join('')}</div>`;
    const rel = Object.entries(x.relationships)
      .map(([id, v]) => ({ s: getSurvivor(s, id), v }))
      .filter((r) => r.s && r.s.alive)
      .sort((a, b) => b.v - a.v)
      .slice(0, 2);
    if (rel.length) html += `<p class="muted small">Closest to ${rel.map((r) => esc(first(r.s!))).join(' and ')}.</p>`;
    return html;
  }

  private buildHtml(s: GameState): string {
    let html = this.head('Build', 'Choose a structure, then tap a spot in the compound.');
    html += `<div class="bps">${BLUEPRINTS.map((b) => {
      const short = Object.keys(missingItems(s.inventory, b.inputs)).length > 0;
      return `<button class="bp ${short ? 'short' : ''}" data-a="bp" data-v="${b.type}">
        <b>${esc(b.name)}</b><span class="size">${b.w}×${b.h}</span>
        <p>${esc(b.blurb)}</p>
        <div class="costs">${costChips(s, b.inputs, b.needsTools)}</div>
        <div class="meta">${icon('clock')}${formatDuration(b.minutes)} · Construction</div>
      </button>`;
    }).join('')}</div>`;
    return html;
  }

  private placingHtml(s: GameState): string {
    const bp = blueprint(this.c.placing!)!;
    const g = this.c.view.ghost;
    let html = this.head(`Place ${esc(bp.name)}`, g ? (g.valid ? 'Good spot. Confirm, or tap elsewhere to move it.' : '') : 'Tap a spot in the compound.');
    if (g && !g.valid) html += `<p class="tone-bad">${esc(this.ghostReason ?? 'Cannot build there.')}</p>`;
    html += `<div class="costs">${costChips(s, bp.inputs, bp.needsTools)}</div>`;
    html += `<div class="assign">${icon('person')}Builder ${this.assigneeSelect(s, undefined, this.c.assignee)}</div>`;
    html += `<div class="row"><button class="go" data-a="place-confirm" ${g && g.valid ? '' : 'disabled'}>Mark construction site</button><button class="ghost" data-a="place-cancel">Cancel</button></div>`;
    return html;
  }

  ghostReason: string | null = null;

  private jobsHtml(s: GameState): string {
    let html = this.head('Jobs', `${s.jobs.length} on the board · ${presentSurvivors(s).filter((x) => !x.jobId).length} free hands`);
    if (!s.jobs.length) return html + '<p class="muted">No jobs queued. Tap machines, heaps and beds in the world to find work.</p>';
    const order = { work: 0, haul: 1, travel: 2, fetch: 3, queued: 4 };
    const jobs = [...s.jobs].sort((a, b) => order[a.phase] - order[b.phase]);
    html += jobs
      .map(
        (j) => `<div class="jobrow"><button class="lnk" data-a="goto-job" data-v="${j.id}">${esc(j.label)}${j.auto ? ' <small>auto</small>' : ''}</button>
        <div class="js">${jobStatus(s, j)}</div>
        <div class="row">${j.phase === 'haul' ? '' : this.assigneeSelect(s, j.id, j.preferredId ?? j.assigneeId)}${j.phase === 'haul' ? '' : `<button class="ghost" data-a="cancel" data-v="${j.id}">Cancel</button>`}</div></div>`,
      )
      .join('');
    return html;
  }

  private logHtml(s: GameState): string {
    let html = this.head('Log');
    html += `<ol class="log">${s.log
      .slice(-80)
      .reverse()
      .map((e) => `<li class="tone-${e.tone}"><time>D${dayOf(e.t)} ${clockString(e.t)}</time>${esc(e.text)}</li>`)
      .join('')}</ol>`;
    return html;
  }

  private storesHtml(s: GameState): string {
    const p = s.power;
    const alive = presentSurvivors(s).length;
    const gen = s.objects.find((o) => o.type === 'generator');
    let html = this.head('Stores & systems', `General storage ${fmt(solidCount(s.inventory))}/${storageCapacity(s)}`);
    html += `<h3>${icon('power')}Power</h3><dl class="stats">
      <dt>Demand</dt><dd>${fmt(p.demand, 1)} kW${p.deficit ? ' <span class="tone-bad">— shortfall</span>' : ''}</dd>
      <dt>Supply</dt><dd>${fmt(p.supply, 1)} kW${gen ? ` · generator ${gen.state === 'operational' ? (gen.data.running ? 'running' : gen.on ? 'standby' : 'off') : gen.state}` : ''}</dd>
      <dt>Battery</dt><dd>${p.capacity ? `${fmt(p.stored, 1)}/${p.capacity} kWh` : 'none working'}</dd>
      <dt>Fuel</dt><dd>${fmt(count(s, 'fuel'), 1)} L${p.fuelBurn ? ` · burning ${fmt(p.fuelBurn, 2)} L/h` : ''}</dd></dl>`;
    const consumers = s.objects.filter((o) => (OBJECT_DEFS[o.type].draw ?? 0) > 0 && o.state === 'operational');
    if (consumers.length)
      html += `<ul class="consumers">${consumers.map((o) => `<li><button class="lnk" data-a="sel-obj" data-v="${o.id}">${esc(objectName(o))}</button><span>${OBJECT_DEFS[o.type].draw} kW · ${!o.on ? 'off' : o.powered ? '<span class="tone-good">powered</span>' : '<span class="tone-warn">unpowered</span>'}</span></li>`).join('')}</ul>`;
    html += `<h3>${icon('water')}Water</h3><dl class="stats">
      <dt>Clean</dt><dd>${fmt(count(s, 'water'))}/${cleanCapacity(s)} L · +${fmt(s.water.cleanIn, 1)} L/h</dd>
      <dt>Untreated</dt><dd>${fmt(count(s, 'rawWater'))}/${rawCapacity(s)} L · +${fmt(s.water.rawIn, 1)} L/h</dd>
      <dt>Drinking</dt><dd>~${fmt(alive * 3.6, 0)} L/day for ${alive}</dd></dl>`;
    const beds = s.objects.filter((o) => o.type === 'planter');
    html += `<h3>${icon('food')}Food</h3><dl class="stats">
      <dt>Rations</dt><dd>${fmt(count(s, 'food'), 1)} · eating ~${alive}/day</dd>
      <dt>Planters</dt><dd>${beds.filter((b) => b.state === 'growing').length} growing, ${beds.filter((b) => b.state === 'ready').length} ready, ${beds.length} total</dd></dl>`;
    html += `<h3>${icon('stores')}Materials</h3><div class="inv">${(Object.keys(ITEMS) as ItemId[])
      .filter((k) => !['water', 'rawWater'].includes(k))
      .map((k) => `<div>${icon(k)}<span>${ITEMS[k].name}</span><b>${fmt(count(s, k), 1)}</b></div>`)
      .join('')}</div>`;
    return html;
  }

  // ---------------------------------------------------------------- modals

  private eventHtml(s: GameState): string {
    const e = s.events.pending!;
    const body = e.body.split('\n\n').map((p) => `<p>${esc(p)}</p>`).join('');
    return `<h2 class="ev-title">${esc(e.title)}</h2><div class="ev-body">${body}</div>
      <div class="choices">${e.choices
        .map((c) => `<button class="choice${e.choices.length === 1 ? ' solo' : ''}" data-a="choose" data-v="${c.id}" ${c.available ? '' : 'disabled'}><b>${esc(c.label)}</b>${c.detail ? `<span>${esc(c.detail)}</span>` : ''}${!c.available && c.reason ? `<em>${esc(c.reason)}</em>` : ''}</button>`)
        .join('')}</div>`;
  }

  private mapSvg(s: GameState): string {
    const home = { x: 0.16, y: 0.52 };
    const W = 100;
    const H = 62;
    const pt = (p: { x: number; y: number }) => ({ x: p.x * W, y: p.y * H });
    const h = pt(home);
    let svg = `<svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Regional map">
      <defs><pattern id="grid" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M5 0H0V5" fill="none" stroke="rgba(255,240,210,0.05)" stroke-width="0.3"/></pattern></defs>
      <rect width="${W}" height="${H}" fill="#221d18"/><rect width="${W}" height="${H}" fill="url(#grid)"/>
      <path d="M0 ${H * 0.75} C 30 ${H * 0.6}, 50 ${H * 0.95}, ${W} ${H * 0.8}" stroke="rgba(90,130,150,0.35)" stroke-width="2.4" fill="none"/>
      <path d="M58 0 C 62 20, 70 30, 72 ${H}" stroke="rgba(120,100,70,0.25)" stroke-width="5" fill="none"/>`;
    for (const loc of Object.values(LOCATIONS)) {
      const p = pt(loc.map);
      const sel = this.exp.dest === loc.id;
      const mx = (h.x + p.x) / 2;
      const my = (h.y + p.y) / 2 + (loc.id === 'garage' ? -6 : loc.id === 'pumpStation' ? 4 : -2);
      svg += `<path id="route-${loc.id}" d="M${h.x} ${h.y} Q ${mx} ${my} ${p.x} ${p.y}" stroke="${sel ? '#f2b544' : 'rgba(230,220,200,0.35)'}" stroke-width="${sel ? 0.9 : 0.6}" stroke-dasharray="1.6 1.2" fill="none"/>`;
    }
    svg += `<g class="home"><rect x="${h.x - 4}" y="${h.y - 4}" width="8" height="8" rx="1" fill="#3a3128" stroke="#f2b544" stroke-width="0.6"/><text x="${h.x}" y="${h.y + 8.5}" text-anchor="middle">Compound</text></g>`;
    for (const loc of Object.values(LOCATIONS)) {
      const p = pt(loc.map);
      const st = s.locations[loc.id];
      const sel = this.exp.dest === loc.id;
      svg += `<g class="loc ${sel ? 'sel' : ''}" data-a="exp-dest" data-v="${loc.id}"><circle cx="${p.x}" cy="${p.y}" r="7" fill="transparent"/><circle cx="${p.x}" cy="${p.y}" r="${sel ? 3.4 : 2.8}" fill="${st.visits ? '#6a6052' : '#c98a3a'}" stroke="${sel ? '#f2b544' : '#e8dcc8'}" stroke-width="0.6"/><text x="${p.x}" y="${p.y - 4.6}" text-anchor="middle">${esc(loc.name)}</text>${st.visits ? `<text class="v" x="${p.x}" y="${p.y + 6.5}" text-anchor="middle">visited ×${st.visits}</text>` : ''}</g>`;
    }
    for (const e of s.expeditions) {
      if (e.phase === 'done') continue;
      const loc = LOCATIONS[e.destination];
      const p = pt(loc.map);
      let f = 0;
      if (e.phase === 'outbound') f = Math.min(1, e.elapsed / e.legMinutes);
      else if (e.phase === 'searching' || e.phase === 'decision') f = 1;
      else if (e.phase === 'returning') f = 1 - Math.max(0, e.elapsed) / e.legMinutes;
      const mx = (h.x + p.x) / 2;
      const my = (h.y + p.y) / 2 + (loc.id === 'garage' ? -6 : loc.id === 'pumpStation' ? 4 : -2);
      const bx = (1 - f) * (1 - f) * h.x + 2 * (1 - f) * f * mx + f * f * p.x;
      const by = (1 - f) * (1 - f) * h.y + 2 * (1 - f) * f * my + f * f * p.y;
      svg += `<g class="team"><circle cx="${bx}" cy="${by}" r="2.2" fill="#7fd0ff" stroke="#10202a" stroke-width="0.5"/><circle cx="${bx}" cy="${by}" r="3.6" fill="none" stroke="rgba(127,208,255,0.5)" stroke-width="0.4"><animate attributeName="r" values="2.4;4.6;2.4" dur="1.6s" repeatCount="indefinite"/></circle></g>`;
    }
    return svg + '</svg>';
  }

  private expeditionHtml(s: GameState): string {
    const d = this.exp;
    const loc = LOCATIONS[d.dest];
    const ls = s.locations[d.dest];
    d.members = d.members.filter((id) => {
      const m = getSurvivor(s, id);
      return m && m.alive && !m.away;
    });
    if (d.vehicle && !vehicleAvailable(s)) d.vehicle = false;
    const plan = expeditionPlan(s, d.dest, d.members, d.packed, d.vehicle);
    const err = validateExpedition(s, d.dest, d.members, d.packed, d.vehicle);
    const lootLeft = Object.values(ls.loot).reduce((a, b) => a + (b ?? 0), 0);
    const richness = ls.visits === 0 ? 'Unexplored' : lootLeft > 15 ? 'Still worth a look' : lootLeft > 4 ? 'Mostly picked over' : 'Stripped bare';
    const back = s.minute + plan.total;
    let html = `<div class="ph"><div><h2>Expeditions</h2><p class="sub">Pick a destination, a team of up to ${MAX_TEAM}, and supplies.</p></div><button class="x" data-a="modal-close" aria-label="Close">${icon('close')}</button></div>`;
    html += `<div class="exp-grid"><div class="exp-map">${this.mapSvg(s)}<div class="loc-tabs">${Object.values(LOCATIONS)
      .map((l) => `<button class="${d.dest === l.id ? 'on' : ''}" data-a="exp-dest" data-v="${l.id}">${esc(l.name)}</button>`)
      .join('')}</div></div><div class="exp-plan">`;
    html += `<div class="dest"><h3>${esc(loc.name)}</h3><p>${esc(loc.blurb)}</p><div class="tags"><span>${icon('stores')}${esc(loc.hint)}</span><span>${icon('clock')}${formatDuration(plan.leg)} each way</span><span class="${loc.risk > 0.15 ? 'tone-warn' : ''}">${icon('warn')}${loc.risk > 0.17 ? 'Risky' : loc.risk > 0.13 ? 'Some risk' : 'Low risk'}</span><span>${esc(richness)}</span></div></div>`;
    html += `<h4>Team</h4><div class="team-pick">${presentSurvivors(s)
      .map((x) => {
        const on = d.members.includes(x.id);
        const unfit = x.energy < 25 || x.health < 35;
        return `<button class="mem ${on ? 'on' : ''}" data-a="exp-member" data-v="${x.id}" ${unfit && !on ? 'disabled' : ''}><img src="${portrait(x)}" alt=""><span><b>${esc(first(x))}</b><small>${x.role}${x.skills.scavenging ? ` · scav ${'●'.repeat(x.skills.scavenging)}` : ''}</small><small>${unfit ? (x.energy < 25 ? 'exhausted' : 'hurt') : `energy ${Math.round(x.energy)}`}</small></span></button>`;
      })
      .join('')}</div>`;
    const stepper = (id: ItemId, label: string, step: number) => `<div class="step"><span>${icon(id)}${label}<small>have ${fmt(count(s, id), 1)}</small></span><button data-a="exp-pack" data-v="${id}|${-step}" aria-label="less">−</button><b>${fmt(d.packed[id] ?? 0)}</b><button data-a="exp-pack" data-v="${id}|${step}" aria-label="more">+</button></div>`;
    html += `<h4>Supplies</h4><div class="steps">${stepper('water', 'Water (L)', 2)}${stepper('food', 'Food', 1)}${stepper('tools', 'Tool kit', 1)}${stepper('meds', 'Meds', 1)}</div>`;
    html += `<p class="hint">${d.members.length ? `Bring at least ${plan.waterNeeded} L of water for ${d.members.length}. Tools make the search ~35% more thorough; meds treat injuries on the spot.` : 'Choose who goes.'}</p>`;
    if (vehicleAvailable(s)) html += `<button class="toggle ${d.vehicle ? 'on' : ''}" data-a="exp-vehicle">${icon('engine')}Take the forklift — +60% cargo, 25% faster, uses 1 fuel</button>`;
    if (d.members.length)
      html += `<dl class="stats"><dt>Away</dt><dd>${formatDuration(plan.total)} · back ~Day ${dayOf(back)} ${clockString(back)}</dd><dt>Cargo</dt><dd>${plan.cap} items + ${plan.waterCap} L</dd><dt>Search</dt><dd>${bar(plan.quality * 100, 'fd')} ${Math.round(plan.quality * 100)}% thorough</dd></dl>`;
    if (back > s.weather.stormStart && s.minute < s.weather.stormStart && s.weather.stormForecastKnown) html += `<p class="tone-warn">${icon('storm')}The storm will catch this team on the road.</p>`;
    html += `<button class="go big" data-a="exp-send" ${err ? 'disabled' : ''}>${err ? esc(err) : `Send ${d.members.map((id) => first(getSurvivor(s, id)!)).join(' & ')}`}</button>`;
    html += `</div></div>`;
    const active = s.expeditions.filter((e) => e.phase !== 'done' || s.minute - e.startedAt < 3 * 60);
    if (active.length) {
      html += `<h4>Under way</h4>${active
        .map((e) => {
          const f = e.phase === 'outbound' ? e.elapsed / e.legMinutes / 2 : e.phase === 'returning' ? 0.5 + Math.max(0, e.elapsed) / e.legMinutes / 2 : e.phase === 'done' ? 1 : 0.5;
          const phase = { outbound: 'Travelling out', searching: 'Searching', decision: 'Awaiting your call', returning: 'Heading home', done: 'Returned' }[e.phase];
          return `<div class="expcard"><b>${esc(LOCATIONS[e.destination].name)}</b> · ${e.members.map((id) => esc(first(getSurvivor(s, id)!))).join(', ')} · <span>${phase}</span>${bar(f * 100, 'en')}<ul>${e.log.slice(-3).map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
        })
        .join('')}`;
    }
    return html;
  }

  private menuHtml(): string {
    return `<div class="ph"><div><h2>COLONY</h2><p class="sub">Seven Days · ${esc(this.c.saveStatus)}</p></div><button class="x" data-a="modal-close" aria-label="Close">${icon('close')}</button></div>
      <div class="menu-list">
        <button class="go" data-a="modal-close">Resume</button>
        <button class="ghost" data-a="modal" data-v="objectives">${icon('target')}Objectives</button>
        <button class="ghost" data-a="modal" data-v="help">${icon('log')}How to play</button>
        <button class="ghost danger" data-a="modal" data-v="confirmNew">Start a new game</button>
      </div>`;
  }

  private confirmNewHtml(): string {
    return `<h2>Start over?</h2><p>Your current settlement will be lost.</p><div class="row"><button class="go danger" data-a="newgame">Start a new game</button><button class="ghost" data-a="modal-close">Keep playing</button></div>`;
  }

  private objectivesHtml(s: GameState): string {
    const objs = objectives(s);
    const li = (o: (typeof objs)[number]) => `<li class="${o.done ? 'done' : ''}">${icon(o.done ? 'check' : 'target')}<div><b>${esc(o.label)}</b><span>${esc(o.detail)}</span></div>${o.progress ? `<em>${esc(o.progress)}</em>` : ''}</li>`;
    return `<div class="ph"><div><h2>Seven Days</h2><p class="sub">${esc(immediateObjective(s))}</p></div><button class="x" data-a="modal-close" aria-label="Close">${icon('close')}</button></div>
      <h4>Primary</h4><ul class="objs">${objs.filter((o) => !o.optional).map(li).join('')}</ul>
      <h4>Optional</h4><ul class="objs">${objs.filter((o) => o.optional).map(li).join('')}</ul>`;
  }

  private helpHtml(): string {
    return `<div class="ph"><div><h2>How to play</h2></div><button class="x" data-a="modal-close" aria-label="Close">${icon('close')}</button></div>
      <div class="help">
      <p><b>Tap</b> a machine, heap or bed to see what it needs and what you can do: <b>repair</b>, <b>dismantle</b> for parts, or <b>repurpose</b> it into something else. Each choice is permanent.</p>
      <p><b>Tap a survivor</b> (or their card) to select them. With someone selected, jobs you queue go to them; tap the ground to walk them there. Otherwise the best free hand takes the job.</p>
      <p>Workers fetch materials from the <b>supply cache</b> in the warehouse, walk to the job, work at a speed set by their skill, and haul anything recovered back to storage.</p>
      <p><b>Power</b> runs pumps and purifiers. <b>Untreated water</b> makes people sick — treat it. <b>Planters</b> turn seed stock and water into food. A <b>storm</b> is coming: reinforce exposed equipment.</p>
      <p><b>Expeditions</b> (map button) send up to three survivors to scavenge further afield.</p>
      <p><b>Controls</b> — drag to pan, pinch or scroll to zoom. Keyboard: Space pause, 1–3 speed, WASD/arrows pan, B build, J jobs, E expeditions, Esc close.</p>
      </div>`;
  }

  private endHtml(s: GameState): string {
    const r = s.result!;
    return `<div class="end ${r.status}"><p class="kicker">${r.status === 'won' ? 'Scenario complete' : 'Scenario failed'}</p><h2>${esc(r.grade)}</h2><p class="headline">${esc(r.headline)}</p>
      <ul class="objs">${r.objectives.map((o) => `<li class="${o.done ? 'done' : ''}">${icon(o.done ? 'check' : 'close')}<div><b>${esc(o.label)}</b></div></li>`).join('')}</ul>
      <ul class="summary">${r.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      ${s.stats.choices.length ? `<h4>Key choices</h4><ul class="summary">${s.stats.choices.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      <div class="row"><button class="go" data-a="newgame">Play again</button><button class="ghost" data-a="modal-close">Look around</button></div></div>`;
  }

  // ---------------------------------------------------------------- events

  private onChange(e: Event): void {
    const el = e.target as HTMLSelectElement;
    const a = el.dataset.a;
    if (a === 'assign') {
      const r = this.c.command({ type: 'assignJob', jobId: el.dataset.v!, survivorId: el.value || null });
      this.toast(r.message, r.ok);
    } else if (a === 'set-assignee') {
      this.c.assignee = el.value || null;
      if (el.value) this.c.view.selectedSurvivor = el.value;
    }
    this.update(true);
  }

  private onClick(e: Event): void {
    const el = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
    if (!el || el.tagName === 'SELECT') return;
    if ((el as HTMLButtonElement).disabled) return;
    const a = el.dataset.a!;
    const v = el.dataset.v ?? '';
    const c = this.c;
    const s = c.state;
    const run = (cmd: Command) => {
      const r = c.command(cmd);
      this.toast(r.message, r.ok);
      return r;
    };
    switch (a) {
      case 'speed': c.setSpeed(Number(v) as SpeedIndex); break;
      case 'modal': c.openModal(v as ModalKind); break;
      case 'modal-close': c.openModal(null); break;
      case 'panel': c.openPanel(c.panel === v ? null : (v as PanelKind)); if (c.placing) c.cancelPlacing(); break;
      case 'close-panel': c.openPanel(null); c.selectObject(null); break;
      case 'expedition': c.openModal(c.modal === 'expedition' ? null : 'expedition'); break;
      case 'sel-surv': {
        if (c.view.selectedSurvivor === v && c.panel === 'survivor') c.centerOnSurvivor(v);
        c.selectSurvivor(v);
        break;
      }
      case 'sel-obj': c.selectObject(v); c.centerOnObject(v); break;
      case 'center': c.centerOnSurvivor(v); break;
      case 'goto-job': {
        const j = s.jobs.find((x) => x.id === v);
        if (j && j.kind === 'treat') c.selectSurvivor(j.targetId);
        else if (j) {
          c.selectObject(j.targetId);
          c.centerOnObject(j.targetId);
        }
        break;
      }
      case 'queue': {
        const [objectId, actionId] = v.split('|');
        run({ type: 'queueAction', objectId, actionId, assigneeId: c.assignee });
        break;
      }
      case 'toggle': run({ type: 'toggle', objectId: v }); break;
      case 'cancel': run({ type: 'cancelJob', jobId: v }); break;
      case 'stopjob': {
        const x = getSurvivor(s, v);
        if (x?.jobId) run({ type: 'assignJob', jobId: x.jobId, survivorId: null });
        break;
      }
      case 'treat': run({ type: 'treat', patientId: v, assigneeId: null }); break;
      case 'autowork': {
        const x = getSurvivor(s, v);
        if (x) run({ type: 'setAutoWork', survivorId: v, value: !x.autoWork });
        break;
      }
      case 'bp': c.startPlacing(v as ObjectType); break;
      case 'place-confirm': c.confirmPlacing(); break;
      case 'place-cancel': c.cancelPlacing(); break;
      case 'choose': run({ type: 'choose', choiceId: v }); break;
      case 'exp-dest': this.exp.dest = v as LocationId; break;
      case 'exp-member': {
        const i = this.exp.members.indexOf(v);
        if (i >= 0) this.exp.members.splice(i, 1);
        else if (this.exp.members.length < MAX_TEAM) this.exp.members.push(v);
        else this.toast(`At most ${MAX_TEAM} can go.`, false);
        break;
      }
      case 'exp-pack': {
        const [id, d] = v.split('|');
        const k = id as ItemId;
        const next = Math.max(0, Math.min(count(s, k), (this.exp.packed[k] ?? 0) + Number(d)));
        this.exp.packed[k] = Math.floor(next * 10) / 10;
        if (!this.exp.packed[k]) delete this.exp.packed[k];
        break;
      }
      case 'exp-vehicle': this.exp.vehicle = !this.exp.vehicle; break;
      case 'exp-send': {
        const r = run({ type: 'expedition', destination: this.exp.dest, members: [...this.exp.members], packed: { ...this.exp.packed }, vehicle: this.exp.vehicle });
        if (r.ok) {
          this.exp.members = [];
          this.exp.packed = { water: 6 };
          this.exp.vehicle = false;
        }
        break;
      }
      case 'newgame': c.newGame(); break;
    }
    this.update(true);
  }
}
