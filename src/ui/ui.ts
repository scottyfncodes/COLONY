import { BLUEPRINTS, OBJECT_DEFS, objectName, blueprint, type ActionDef } from '../sim/actions';
import { expeditionPlan, LOCATIONS, MAX_TEAM, validateExpedition, vehicleAvailable } from '../sim/expeditions';
import { GEN_OUTPUT, irrigated, BATTERY_CAPACITY } from '../sim/infrastructure';
import { cleanCapacity, count, rawCapacity, roomFor, storageCapacity } from '../sim/inventory';
import { ITEMS, describeItems, missingItems, solidCount } from '../sim/items';
import { actionBlocked, availableActions, getObject, getSurvivor, jobWaitingOn, workRate } from '../sim/jobs';
import { immediateObjective, objectives } from '../sim/scenario';
import { blueprintAvailable, canToggle } from '../sim/sim';
import { TRAITS } from '../sim/setup';
import { presentSurvivors } from '../sim/survivors';
import { clockString, dayOf, formatDuration, isNight } from '../sim/time';
import type { CatastropheId, Command, CommandResult, GameState, ItemId, Items, Job, LocationId, ObjectType, Survivor, WorldObject } from '../sim/types';
import type { ViewState } from '../render/renderer';
import type { SpeedIndex } from '../sim/time';
import { icon } from './icons';
import { defaultDraft, draftOptions, hazardPill, scenarioSelectHtml, SCENARIO_ICON, worldPanelHtml, type NewGameDraft } from './scenarioUi';
import { CATASTROPHES, difficultyInfo, isActive, locationHazard, radiationNow, type NewGameOptions } from '../sim/catastrophes';
import { portrait } from './portraits';
import { Coach } from './coach';
import { bestFor, brutalUnlocked, shortGrade, type RunRecord } from './history';
import { bond, bondLabel } from '../sim/social';
import { objectiveTarget } from '../sim/scenario';
import type { Cue } from '../audio/audio';

export type PanelKind = 'object' | 'survivor' | 'build' | 'jobs' | 'log' | 'stores' | 'world' | null;
export type ModalKind = 'expedition' | 'menu' | 'objectives' | 'help' | 'end' | 'confirmNew' | 'scenario' | 'recap' | null;

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
  newGame(opts?: Partial<NewGameOptions>): void;
  saveStatus: string;
  muted: boolean;
  toggleMute(): void;
  cue(c: Cue): void;
  history: RunRecord[];
  continueEndless(): void;
  settle(): void;
  pref(key: string): string | null;
  setPref(key: string, value: string | null): void;
}

/** What each top-bar number means, where it comes from and where it goes. */
const RES_INFO: Record<string, { name: string; text: string }> = {
  food: { name: 'Food rations', text: 'Everyone eats about one a day. Grow more in planters, or scavenge at the market.' },
  water: { name: 'Safe water', text: 'Each person drinks about 3.6 L a day. Filters, the purifier or boiling turn untreated water into this.' },
  rawWater: { name: 'Untreated water', text: 'From the well, a bucket or the rain. Drinking it can make people sick, so treat it first.' },
  fuel: { name: 'Diesel', text: 'Runs the generator. Siphon wrecks, drain drums, or search the garage.' },
  power: { name: 'Power', text: 'Demand / supply in kW. The generator (later a turbine or battery bank) runs the pump, purifier, lamps, workbench and radio.' },
  scrap: { name: 'Scrap', text: 'The basic material for building and repairs. Salvage heaps and dismantle junk for more.' },
  mech: { name: 'Mechanical parts', text: 'Bearings, gears and belts. Engines, pumps and gates need them.' },
  elec: { name: 'Electrical parts', text: 'Wire, relays and fuses. Wiring, the radio and the battery bank need them.' },
  battery: { name: 'Battery cells', text: 'Re-cell the battery bank so spare power is stored instead of wasted.' },
  tools: { name: 'Tool kits', text: 'Most jobs need a free kit, returned when the job is done. More kits means more jobs at once.' },
  meds: { name: 'Medical supplies', text: 'Treat injuries, illness, bites and radiation. The medic uses them best.' },
  engine: { name: 'Salvaged engine', text: 'Fit it to the generator for a more fuel-efficient engine.' },
  filter: { name: 'Filter cartridges', text: 'Fit one to a sand filter to double its output.' },
};

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
  trapped: 'Trapped',
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
  draft: NewGameDraft = defaultDraft();
  private sheet: HTMLDivElement | null = null;
  coach = new Coach();
  resOpen: string | null = null;
  private peek = false;
  private panelKey = '';
  private samples: { m: number; inv: Items }[] = [];
  private drag: { y0: number; dy: number } | null = null;

  constructor(private root: HTMLElement, private c: Controller) {
    root.insertAdjacentHTML(
      'beforeend',
      `<div id="hud"><header id="top"><div id="clock"></div><div id="speed"></div><div id="res"></div></header>
       <div id="respop" class="hidden"></div>
       <div id="objective"></div>
       <div id="alerts"></div></div>
       <div id="bottom"><div id="coach" class="hidden"></div><aside id="panel" class="hidden"></aside>
       <nav id="dock"></nav>
       <footer id="roster"></footer></div>
       <div id="toasts"></div>
       <div id="modal" class="hidden"></div>`,
    );
    for (const id of ['top', 'clock', 'res', 'speed', 'respop', 'objective', 'alerts', 'coach', 'panel', 'dock', 'roster', 'toasts', 'modal']) this.els[id] = document.getElementById(id)!;
    this.bindSheetDrag();
    root.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('#top,#panel,#dock,#roster,#modal,#objective,#alerts,#respop,#coach')) this.pointerDown = true;
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
    this.placeToasts();
    while (t.children.length > 3) t.firstChild!.remove();
    window.clearTimeout(this.toastTimer);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3200);
  }

  /** On phones, keep messages just above an open bottom panel instead of over the HUD. */
  private placeToasts(): void {
    const t = this.els.toasts;
    const stack = [this.els.coach, this.els.panel].filter((el) => !el.classList.contains('hidden'));
    if (window.innerWidth < 760 && stack.length) {
      const top = Math.min(...stack.map((el) => el.getBoundingClientRect().top));
      t.style.top = 'auto';
      t.style.bottom = `${Math.round(window.innerHeight - top + 8)}px`;
    } else {
      t.style.top = '';
      t.style.bottom = '';
    }
  }

  /** Drag the phone panel by its handle: down to shrink to a peek (or close), up to expand. */
  private bindSheetDrag(): void {
    const panel = this.els.panel;
    panel.addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement).closest('.grab')) return;
      this.drag = { y0: e.clientY, dy: 0 };
      panel.setPointerCapture(e.pointerId);
      panel.style.transition = 'none';
    });
    panel.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      this.drag.dy = e.clientY - this.drag.y0;
      panel.style.transform = `translateY(${Math.max(-20, this.drag.dy)}px)`;
    });
    const end = () => {
      if (!this.drag) return;
      const dy = this.drag.dy;
      this.drag = null;
      panel.style.transition = '';
      panel.style.transform = '';
      if (Math.abs(dy) < 6) this.peek = !this.peek;
      else if (dy > 50) {
        if (this.peek) {
          this.c.openPanel(null);
          this.c.cue('close');
        } else this.peek = true;
      } else if (dy < -30) this.peek = false;
      this.update(true);
    };
    panel.addEventListener('pointerup', end);
    panel.addEventListener('pointercancel', end);
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
    this.sample(s);
    this.c.view.beacon = this.c.placing ? null : objectiveTarget(s);
    const resPop = this.resPopHtml(s);
    this.show('respop', !!resPop);
    if (resPop) this.set('respop', resPop);
    const key = `${this.c.panel}|${this.c.view.selectedObject}|${this.c.view.selectedSurvivor}|${this.c.placing}`;
    if (key !== this.panelKey) {
      this.panelKey = key;
      this.peek = false;
    }
    const panel = this.panelHtml(s);
    this.show('panel', !!panel);
    this.root.classList.toggle('panel-open', !!panel);
    this.root.classList.toggle('panel-peek', !!panel && this.peek);
    if (panel) this.set('panel', `<div class="grab" aria-label="Drag to resize"><span></span></div>${panel}`);
    this.updateCoach(s);
    if (this.els.toasts.childElementCount) this.placeToasts();
    // Modals: a pending event always takes precedence.
    let modal = '';
    if (this.c.modal === 'scenario') modal = scenarioSelectHtml(s, this.draft, this.c.history);
    else if (s.events.pending) modal = this.eventHtml(s);
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
        case 'recap': modal = this.recapHtml(s); break;
      }
    }
    this.show('modal', !!modal);
    const kind = `sheet m-${this.c.modal === 'scenario' ? 'scenario' : s.events.pending ? `event ev-${s.events.pending.id}` : this.c.modal ?? ''}`;
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
    this.samples = [];
  }

  // ---------------------------------------------------------------- coach & resource help

  private updateCoach(s: GameState): void {
    const v = { state: s, speed: this.c.speed, panel: this.c.panel, selectedObject: this.c.view.selectedObject, resOpen: this.resOpen };
    if (this.coach.tick(v)) this.c.cue('good');
    const panelOpen = !this.els.panel.classList.contains('hidden') && window.innerWidth < 760;
    const show = this.coach.active && !this.c.modal && !s.events.pending && !this.coach.yields(panelOpen);
    this.show('coach', show);
    this.root.classList.toggle('coach-on', show);
    this.set('coach', show ? this.coach.html(v) : '');
    const glow = show ? this.coach.glow() : undefined;
    for (const el of this.root.querySelectorAll('.coach-glow')) if (!glow || !el.matches(glow)) el.classList.remove('coach-glow');
    if (glow) for (const el of this.root.querySelectorAll(glow)) el.classList.add('coach-glow');
  }

  startCoach(): void {
    const s = this.c.state;
    this.coach.start({ state: s, speed: this.c.speed, panel: this.c.panel, selectedObject: this.c.view.selectedObject, resOpen: this.resOpen });
  }

  /** Keep a few hours of stock levels so the help card can say how fast things are changing. */
  private sample(s: GameState): void {
    const last = this.samples[this.samples.length - 1];
    if (last && s.minute < last.m) this.samples = [];
    if (!last || s.minute - last.m >= 30) {
      this.samples.push({ m: s.minute, inv: { ...s.inventory } });
      if (this.samples.length > 7) this.samples.shift();
    }
  }

  private rate(s: GameState, id: ItemId): number | null {
    const old = this.samples.find((x) => s.minute - x.m >= 60);
    if (!old) return null;
    return ((count(s, id) - (old.inv[id] ?? 0)) / (s.minute - old.m)) * 60;
  }

  private resPopHtml(s: GameState): string {
    const id = this.resOpen;
    if (!id) return '';
    const info = RES_INFO[id];
    if (!info) return '';
    const alive = presentSurvivors(s).length || 1;
    const lines: string[] = [];
    let amount = '';
    if (id === 'power') {
      const p = s.power;
      amount = p.supply > 0 || p.stored > 0 ? `${fmt(p.demand, 1)} kW used of ${fmt(p.supply, 1)} kW` : 'No power';
      if (p.capacity) lines.push(`Battery ${Math.round((p.stored / p.capacity) * 100)}% charged`);
      if (p.deficit) lines.push('<span class="tone-bad">Short: some equipment has shut off</span>');
    } else {
      const k = id as ItemId;
      amount = `${fmt(count(s, k), 1)}${ITEMS[k].unit ? ` ${ITEMS[k].unit}` : ''}`;
      const r = this.rate(s, k);
      if (r !== null && Math.abs(r) >= 0.05) lines.push(`<span class="tone-${r > 0 ? 'good' : 'warn'}">${r > 0 ? '+' : '−'}${fmt(Math.abs(r), 1)} per hour</span>`);
      else if (r !== null) lines.push('Steady');
      if (k === 'food') lines.push(`Lasts ~${fmt(count(s, 'food') / alive, 1)} days for ${alive}`);
      if (k === 'water') lines.push(`Lasts ~${fmt(count(s, 'water') / (alive * 3.6), 1)} days for ${alive}`);
    }
    return `<div class="rp-card"><div class="rp-h">${icon(id === 'power' ? 'power' : id)}<b>${info.name}</b><span class="rp-amt">${amount}</span><button class="x" data-a="res-close" aria-label="Close">${icon('close')}</button></div>
      ${lines.length ? `<p class="rp-line">${lines.join(' · ')}</p>` : ''}<p>${info.text}</p>
      <button class="lnk" data-a="res-stores">${icon('stores')}All stores &amp; systems</button></div>`;
  }

  // ---------------------------------------------------------------- top bar

  private clockHtml(s: GameState): string {
    const night = isNight(s.minute);
    const wx = s.weather;
    const wxIcon = wx.kind === 'storm' ? 'storm' : wx.kind === 'rain' ? 'rain' : wx.kind === 'overcast' ? 'cloud' : night ? 'moon' : 'sun';
    const wxText = { storm: 'Storm', rain: 'Rain', overcast: 'Overcast', clear: night ? 'Night' : 'Clear' }[wx.kind];
    let storm = '';
    const c = s.world.climax;
    if (c.kind !== 'storm') {
      const left = c.at - s.minute;
      if (!c.resolved)
        storm =
          left <= 0
            ? `<span class="storm live">${icon('shield')}${esc(c.label)}</span>`
            : c.known
              ? `<span class="storm ${left < 24 * 60 ? 'soon' : ''}">${icon('shield')}${formatDuration(left)}</span>`
              : `<span class="storm vague" title="Repair the radio for better intelligence">${icon('shield')}${s.minute > 32 * 60 ? `~Day ${dayOf(c.at)}` : 'coming'}</span>`;
    } else if (wx.kind === 'storm') storm = `<span class="storm live">${icon('storm')}Storm · ends in ${formatDuration(wx.stormEnd - s.minute)}</span>`;
    else if (!wx.stormResolved) {
      const left = wx.stormStart - s.minute;
      storm = wx.stormForecastKnown
        ? `<span class="storm ${left < 24 * 60 ? 'soon' : ''}">${icon('storm')}${formatDuration(left)}</span>`
        : `<span class="storm vague" title="Repair the radio for an exact forecast">${icon('storm')}${s.minute > 32 * 60 ? `~Day ${dayOf(wx.stormStart) - (s.seed % 2)}–${dayOf(wx.stormStart) + 1}` : 'coming'}</span>`;
    }
    const endless = !!s.flags.endless;
    return `<div class="day"><b>Day ${endless ? dayOf(s.minute) : Math.min(7, dayOf(s.minute))}</b><span class="of">${endless ? '∞' : '/7'}</span><span class="time">${clockString(s.minute)}</span></div>
      <div class="wx">${icon(wxIcon)}<span>${wxText}</span>${storm}</div>`;
  }

  private resHtml(s: GameState): string {
    const alive = presentSurvivors(s).length;
    const lowFood = count(s, 'food') < Math.max(4, alive);
    const lowWater = count(s, 'water') < Math.max(10, alive * 3);
    const p = s.power;
    const gen = s.objects.find((o) => o.type === 'generator');
    const running = !!gen?.data.running;
    const powerTxt = p.supply > 0 || p.stored > 0 ? `${fmt(p.demand, 1)}/${fmt(p.supply + (p.stored > 0 ? 6 : 0), 1)}` : 'off';
    const btn = (id: string, html: string) => html.replace('<span class="chip', `<button data-a="res" data-v="${id}" aria-label="${RES_INFO[id].name}" class="chip${this.resOpen === id ? ' open' : ''}`).replace(/<\/span>$/, '</button>');
    const rows = [
      btn('food', chip('food', count(s, 'food'), lowFood ? 'low' : '')),
      btn('water', chip('water', count(s, 'water'), lowWater ? 'low' : '')),
      btn('rawWater', chip('rawWater', count(s, 'rawWater'))),
      btn('fuel', chip('fuel', count(s, 'fuel'), count(s, 'fuel') < 2 ? 'low' : '')),
      btn('power', `<span class="chip power ${p.deficit ? 'low' : running || p.supply > 0 ? 'on' : ''}">${icon('power')}<b>${powerTxt}</b>${p.capacity ? `<i>${Math.round((p.stored / p.capacity) * 100)}%</i>` : ''}</span>`),
      btn('scrap', chip('scrap', count(s, 'scrap'))),
      btn('mech', chip('mech', count(s, 'mech'))),
      btn('elec', chip('elec', count(s, 'elec'))),
      btn('battery', chip('battery', count(s, 'battery'))),
      btn('tools', chip('tools', count(s, 'tools'), count(s, 'tools') < 1 ? 'low' : '')),
      btn('meds', chip('meds', count(s, 'meds'))),
    ];
    if (count(s, 'engine')) rows.push(btn('engine', chip('engine', count(s, 'engine'), 'special')));
    if (count(s, 'filter')) rows.push(btn('filter', chip('filter', count(s, 'filter'), 'special')));
    return `<div class="res-btn">${rows.join('')}</div>`;
  }

  private speedHtml(): string {
    const btn = (i: SpeedIndex, ic: string, label: string) => `<button class="${this.c.speed === i ? 'on' : ''}" data-a="speed" data-v="${i}" aria-label="${label}">${icon(ic)}</button>`;
    return `${btn(0, 'pause', 'Pause')}${btn(1, 'play', 'Normal speed')}${btn(2, 'ff', 'Fast')}${btn(3, 'fff', 'Fastest')}<button class="menu" data-a="modal" data-v="menu" aria-label="Menu">${icon('menu')}</button>`;
  }

  private objectiveHtml(s: GameState): string {
    const objs = objectives(s).filter((o) => !o.optional);
    const done = objs.filter((o) => o.done).length;
    const target = objectiveTarget(s);
    return `<div class="obj-pill"><button class="obj-go" data-a="obj-go" ${target ? '' : 'data-none="1"'} aria-label="Go to the current objective">${icon('target')}<span class="obj-text">${esc(immediateObjective(s))}</span></button><button class="obj-count" data-a="modal" data-v="objectives" aria-label="All objectives">${done}/${objs.length}</button></div>`;
  }

  private alertsHtml(s: GameState): string {
    const out: string[] = [hazardPill(s)];
    const idle = presentSurvivors(s).filter((x) => x.activity === 'idle' && !x.jobId && !x.moveTarget);
    if (idle.length && !s.events.pending) out.push(`<button class="alert" data-a="sel-surv" data-v="${idle[0].id}">${icon('person')}${idle.length} idle</button>`);
    const blocked = s.jobs.filter((j) => j.phase === 'queued' && jobWaitingOn(s, j));
    if (blocked.length) out.push(`<button class="alert warn" data-a="panel" data-v="jobs">${icon('jobs')}${blocked.length} waiting on parts</button>`);
    const sick = presentSurvivors(s).filter((x) => x.sick > 0 || x.injury > 40 || x.health < 40);
    if (sick.length) out.push(`<button class="alert bad" data-a="sel-surv" data-v="${sick[0].id}">${icon('heart')}${sick.length} need care</button>`);
    if (count(s, 'water') < 10) out.push(`<button class="alert bad" data-a="panel" data-v="stores">${icon('water')}Low water — options</button>`);
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
      b('panel', 'world', SCENARIO_ICON[s.world.catastrophe], 'World', p === 'world', s.world.director.pending.length ? '!' : ''),
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
      case 'world': return worldPanelHtml(s);
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
      ${x.dose > 1 || radiationNow(s) > 0 ? `<div class="need"><span>Radiation</span>${bar(Math.min(100, x.dose / 4), 'rad')}<b>${Math.round(x.dose)}</b><em class="tag ${x.dose > 250 ? 'bad' : x.dose > 100 ? 'warn' : ''}">mSv</em></div>` : ''}
    </div>`;
    const cond: string[] = [];
    if (x.trapped) cond.push(`<span class="tone-bad">Pinned under rubble. Dig them out before they’re crushed.</span>`);
    if (x.illness?.kind === 'bite') cond.push(`<span class="tone-bad">Bitten${x.illness.stage === 'sick' ? ' — the infection has turned' : ''}. Treat with 2 meds; the medic is most reliable.</span>`);
    if (x.illness?.kind === 'fever' && x.illness.stage === 'sick') cond.push(`<span class="tone-bad">Fever — contagious to anyone close by. ${x.quarantined ? 'In quarantine.' : 'Isolate them.'}</span>`);
    if (x.illness?.kind === 'fever' && x.illness.stage === 'incubating' && x.illness.t < 8 * 60) cond.push(`<span class="tone-warn">Looks flushed. Might be coming down with something.</span>`);
    if (x.immune) cond.push('<span class="tone-good">Recovered from the fever: immune.</span>');
    if (x.dose > 100) cond.push(`<span class="tone-warn">Radiation sickness. Keep them indoors; treatment brings the dose down.</span>`);
    if (cond.length) html += `<div class="conds">${cond.join('')}</div>`;
    html += `<div class="doing">${icon(x.away ? 'map' : x.activity === 'sleeping' ? 'bed' : 'clock')}<span>${x.away ? 'On an expedition' : esc(ACTIVITY[x.activity] ?? x.activity)}${job ? ` — ${esc(job.label)}` : ''}</span></div>`;
    if (!x.away) {
      html += `<div class="row wrap">`;
      if (job) html += `<button class="ghost" data-a="stopjob" data-v="${x.id}">Stop job</button>`;
      const medsNeeded = x.illness?.kind === 'bite' ? 2 : 1;
      const needsCare = x.injury > 0 || x.sick > 0 || x.health < 80 || x.dose >= 80 || x.illness?.kind === 'bite' || x.illness?.stage === 'sick';
      if (needsCare && !s.jobs.some((j) => j.kind === 'treat' && j.targetId === x.id))
        html += `<button class="ghost" data-a="treat" data-v="${x.id}" ${count(s, 'meds') < medsNeeded ? 'disabled' : ''}>${icon('meds')}Treat (${medsNeeded} meds)</button>`;
      if (x.trapped) {
        const r = s.objects.find((o) => o.type === 'rubble' && o.state === 'pile' && o.data.trapped);
        if (r) html += `<button class="ghost" data-a="sel-obj" data-v="${r.id}">${icon('warn')}Show the rubble</button>`;
      } else if (x.quarantined || x.illness || isActive(s, 'pandemic') || isActive(s, 'outbreak'))
        html += `<button class="ghost ${x.quarantined ? 'on' : ''}" data-a="quarantine" data-v="${x.id}">${x.quarantined ? 'End quarantine' : 'Quarantine'}</button>`;
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
    const rel = s.survivors
      .filter((o) => o !== x && o.alive)
      .map((o) => ({ o, v: bond(x, o), label: bondLabel(bond(x, o)) }))
      .filter((r) => r.label)
      .sort((a, b) => b.v - a.v);
    html += `<h4>Relationships</h4>`;
    html += rel.length
      ? `<div class="rels">${rel.map((r) => `<span class="rel ${r.v < 0 ? 'rival' : r.v >= 70 ? 'close' : ''}"><img src="${portrait(r.o)}" alt="">${esc(first(r.o))}<small>${r.label}</small></span>`).join('')}</div>
        <p class="muted small">Friends lift each other’s morale and work faster side by side; rivals drag each other down. Time together in good conditions builds bonds.</p>`
      : `<p class="muted small">No strong ties yet. Time together in good conditions builds friendships.</p>`;
    return html;
  }

  private buildHtml(s: GameState): string {
    let html = this.head('Build', 'Choose a structure, then tap a spot in the compound.');
    html += `<div class="bps">${BLUEPRINTS.filter((b) => blueprintAvailable(s, b.type)).map((b) => {
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
    html += this.waterOptions(s);
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

  /** Every route to drinking water, with whether it works right now and what it needs. */
  private waterOptions(s: GameState): string {
    const find = (t: string) => s.objects.find((o) => o.type === t && o.state !== 'dismantled');
    const all = (t: string) => s.objects.filter((o) => o.type === t && o.state === 'operational');
    const pump = find('waterPump');
    const table = find('table');
    const raw = count(s, 'rawWater');
    const rows: { ok: boolean; label: string; note: string; obj?: string }[] = [];
    rows.push({ ok: !!pump, label: 'Bucket from the well', note: pump ? '10 L untreated per trip, no power' : 'well pump was dismantled', obj: pump?.id });
    rows.push({
      ok: !!pump && pump.state === 'operational' && pump.on && pump.powered,
      label: 'Well pump',
      note: !pump ? 'dismantled' : pump.state !== 'operational' ? `${pump.state} — repair it` : pump.powered ? '30 L/h untreated' : 'needs power (1.5 kW)',
      obj: pump?.id,
    });
    rows.push({ ok: true, label: 'Rain', note: `barrels and tank catch it when it rains${all('rainCatcher').length ? `, plus ${all('rainCatcher').length} catcher(s)` : ' — catchers collect far more'}` });
    rows.push({ ok: raw >= 8 && !!table && count(s, 'scrap') >= 1, label: 'Boil at the mess table', note: '8 L untreated + 1 scrap → 7 L safe', obj: table?.id });
    rows.push({ ok: all('sandFilter').length > 0, label: 'Sand filter', note: all('sandFilter').length ? 'treating automatically' : 'build one: 4 scrap, 1 mech' });
    rows.push({ ok: all('purifier').length > 0, label: 'Boiler purifier', note: all('purifier').length ? '15 L/h with power' : 'build one: needs power' });
    rows.push({ ok: true, label: 'Ridge Pump Station', note: 'its hand pump fills containers every visit' });
    return `<h4>Ways to get drinking water</h4><ul class="wateropts">${rows
      .map((r) => `<li class="${r.ok ? 'ok' : ''}">${icon(r.ok ? 'check' : 'close')}${r.obj ? `<button class="lnk" data-a="sel-obj" data-v="${r.obj}">${esc(r.label)}</button>` : `<b>${esc(r.label)}</b>`}<span>${esc(r.note)}</span></li>`)
      .join('')}</ul>`;
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
    const hz = locationHazard(s, d.dest);
    const route = s.world.routes[d.dest];
    let html = `<div class="ph"><div><h2>Expeditions</h2><p class="sub">Pick a destination, a team of up to ${MAX_TEAM}, and supplies.</p></div><button class="x" data-a="modal-close" aria-label="Close">${icon('close')}</button></div>`;
    html += `<div class="exp-grid"><div class="exp-map">${this.mapSvg(s)}<div class="loc-tabs">${Object.values(LOCATIONS)
      .map((l) => {
        const r = s.world.routes[l.id];
        const cut = r && r.until > s.minute;
        return `<button class="${d.dest === l.id ? 'on' : ''} ${cut ? 'cut' : ''}" data-a="exp-dest" data-v="${l.id}">${esc(l.name)}${cut ? ' ✕' : ''}</button>`;
      })
      .join('')}</div></div><div class="exp-plan">`;
    html += `<div class="dest"><h3>${esc(loc.name)}</h3><p>${esc(loc.blurb)}</p><div class="tags"><span>${icon('stores')}${esc(loc.hint)}</span><span>${icon('clock')}${formatDuration(plan.leg)} each way</span><span class="${loc.risk > 0.15 ? 'tone-warn' : ''}">${icon('warn')}${loc.risk > 0.17 ? 'Risky' : loc.risk > 0.13 ? 'Some risk' : 'Low risk'}</span><span>${esc(richness)}</span>${hz.notes.map((n) => `<span class="tone-warn">${icon('warn')}${esc(n)}</span>`).join('')}</div>${
      route && route.until > s.minute ? `<p class="tone-bad">${icon('warn')} ${esc(route.reason)} Clears ~Day ${dayOf(route.until)} ${clockString(route.until)}.</p>` : ''
    }</div>`;
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
        <button class="ghost" data-a="tutorial">${icon('target')}Replay the tutorial</button>
        <button class="ghost ${this.c.muted ? '' : 'on'}" data-a="mute">${icon(this.c.muted ? 'close' : 'check')}Sound ${this.c.muted ? 'off' : 'on'} <small>(M)</small></button>
        ${this.c.state.flags.endless && !this.c.state.result ? `<button class="ghost" data-a="settle">${icon('check')}Settle here — end the run</button>` : ''}
        <button class="ghost danger" data-a="modal" data-v="scenario">Start a new game</button>
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
      ${this.recordLine(s)}
      ${r.status === 'won' && !s.flags.endless ? `<button class="go big endless" data-a="endless">${icon('ff')}Keep going — endless mode<small>Every day after this is harder. How long can they last?</small></button>` : ''}
      <div class="row"><button class="${r.status === 'won' && !s.flags.endless ? 'ghost' : 'go'}" data-a="modal" data-v="scenario">Play again</button><button class="ghost" data-a="modal-close">Look around</button></div></div>`;
  }

  private recordLine(s: GameState): string {
    const h = this.c.history;
    const best = bestFor(h, s.world.catastrophe);
    const runs = h.filter((r) => r.catastrophe === s.world.catastrophe && !r.sandbox).length;
    let out = best ? `<p class="muted small">${runs} ${esc(CATASTROPHES[s.world.catastrophe].name)} run${runs > 1 ? 's' : ''} · best: ${esc(shortGrade(best.grade))}${best.endless ? `, ${best.days} days` : ''}</p>` : '';
    if (brutalUnlocked(h) && !h.slice(0, -1).some((r) => !r.sandbox && r.difficulty !== 'easy' && ['Functioning settlement', 'Thriving settlement'].includes(r.grade)) && s.world.difficulty !== 'easy')
      out += `<p class="tone-good small">${icon('check')}Brutal difficulty unlocked.</p>`;
    return out;
  }

  private recapHtml(s: GameState): string {
    const alive = presentSurvivors(s).length;
    const total = s.survivors.filter((x) => x.alive).length;
    const objs = objectives(s).filter((o) => !o.optional);
    const recent = s.log.filter((e) => e.tone !== 'info').slice(-4).reverse();
    const days = (n: number) => (n >= 10 ? '10+' : fmt(n, 1));
    return `<div class="ph"><div><p class="kicker">Welcome back</p><h2>Day ${dayOf(s.minute)}, ${clockString(s.minute)}</h2><p class="sub">${esc(CATASTROPHES[s.world.catastrophe].name)} · ${esc(difficultyInfo(s.world.difficulty).label)}${s.flags.endless ? ' · endless' : ''}</p></div></div>
      <dl class="stats"><dt>People</dt><dd>${alive} at the compound${total > alive ? `, ${total - alive} away` : ''}${s.stats.deaths.length ? ` · ${s.stats.deaths.length} lost` : ''}</dd>
      <dt>Food</dt><dd>${fmt(count(s, 'food'), 1)} rations · ~${days(count(s, 'food') / Math.max(1, total))} days</dd>
      <dt>Water</dt><dd>${fmt(count(s, 'water'))} L safe · ~${days(count(s, 'water') / Math.max(1, total * 3.6))} days</dd>
      <dt>Objectives</dt><dd>${objs.filter((o) => o.done).length} of ${objs.length} done</dd></dl>
      <p class="recap-next">${icon('target')}<span>${esc(immediateObjective(s))}</span></p>
      ${recent.length ? `<h4>Recently</h4><ol class="log">${recent.map((e) => `<li class="tone-${e.tone}"><time>D${dayOf(e.t)} ${clockString(e.t)}</time>${esc(e.text)}</li>`).join('')}</ol>` : ''}
      <button class="go big" data-a="modal-close">Carry on</button>`;
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
      if (!r.ok) c.cue('error');
      else if (cmd.type === 'queueAction' || cmd.type === 'treat' || cmd.type === 'expedition') c.cue('queue');
      return r;
    };
    if (!['queue', 'res', 'coach-end'].includes(a)) c.cue(a === 'close-panel' || a === 'modal-close' || a === 'res-close' ? 'close' : 'tap');
    switch (a) {
      case 'res': this.resOpen = this.resOpen === v ? null : v; c.cue('open'); break;
      case 'res-close': this.resOpen = null; break;
      case 'res-stores': this.resOpen = null; c.openPanel('stores'); break;
      case 'obj-go': {
        const t = objectiveTarget(s);
        if (!t) c.openModal('objectives');
        else if (t.kind === 'object') {
          c.selectObject(t.id);
          c.centerOnObject(t.id);
        } else {
          c.selectSurvivor(t.id);
          c.centerOnSurvivor(t.id);
        }
        break;
      }
      case 'coach-end': this.coach.stop(); c.setPref('colony.coach', 'done'); c.cue('complete'); break;
      case 'tutorial': c.openModal(null); this.startCoach(); break;
      case 'mute': c.toggleMute(); break;
      case 'endless': c.continueEndless(); break;
      case 'settle': c.openModal(null); c.settle(); break;
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
      case 'begin': c.newGame(draftOptions(this.draft)); break;
      case 'draft': {
        const [k, val] = v.split('|');
        const d = this.draft;
        if (k === 'pick') {
          d.random = val === 'random';
          if (!d.random) d.catastrophe = val as CatastropheId;
        } else if (k === 'main') {
          d.catastrophe = val as CatastropheId;
          d.extra = d.extra.filter((x) => x !== val);
        } else if (k === 'extra') d.extra = d.extra.includes(val as CatastropheId) ? d.extra.filter((x) => x !== val) : [...d.extra, val as CatastropheId];
        else if (k === 'view') d.view = val as NewGameDraft['view'];
        else if (k === 'difficulty') {
          if (val !== 'hard' || brutalUnlocked(c.history) || d.view === 'custom') d.difficulty = val as NewGameDraft['difficulty'];
        }
        else if (k === 'supplies') d.supplies = val as NewGameDraft['supplies'];
        else if (k === 'director') d.director = val as NewGameDraft['director'];
        break;
      }
      case 'quarantine': {
        const x = getSurvivor(s, v);
        if (x) run({ type: 'quarantine', survivorId: v, value: !x.quarantined });
        break;
      }
      case 'sb-add': run({ type: 'sandbox', action: { kind: 'addCatastrophe', catastrophe: v as CatastropheId } }); break;
      case 'sb-cond': {
        const [key, delta] = v.split('|') as ['radiation' | 'horde' | 'threat' | 'flood', string];
        run({ type: 'sandbox', action: { kind: 'setCondition', key, value: s.world[key] + Number(delta) } });
        break;
      }
      case 'sb-event': run({ type: 'sandbox', action: { kind: 'triggerEvent', eventId: v } }); break;
      case 'sb-weather': run({ type: 'sandbox', action: { kind: 'weather', weather: v as 'squall' | 'rain' | 'clear' } }); break;
      case 'sb-supplies': run({ type: 'sandbox', action: { kind: 'supplies', amount: v as 'some' | 'lots' } }); break;
    }
    this.update(true);
  }
}
