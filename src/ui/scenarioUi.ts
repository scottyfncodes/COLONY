import { CATASTROPHE_IDS, CATASTROPHES, defense, difficultyInfo, isActive, locationHazard, radiationNow, type NewGameOptions } from '../sim/catastrophes';
import { directorEvent } from '../sim/director';
import { LOCATIONS } from '../sim/expeditions';
import { triggerableEvents } from '../sim/sandbox';
import { presentSurvivors } from '../sim/survivors';
import { clockString, dayOf, formatDuration, START_MINUTE } from '../sim/time';
import type { CatastropheId, Difficulty, GameState, LocationId } from '../sim/types';
import { icon } from './icons';

// Scenario selection, the World panel (conditions, warnings, sandbox controls),
// and the always-visible hazard pill.

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const SCENARIO_ICON: Record<CatastropheId, string> = {
  storm: 'storm2',
  quake: 'quake',
  collapse: 'collapse',
  pandemic: 'pandemic',
  fallout: 'fallout',
  outbreak: 'outbreak',
};

export interface NewGameDraft {
  view: 'pick' | 'custom';
  catastrophe: CatastropheId;
  random: boolean;
  difficulty: Difficulty;
  extra: CatastropheId[];
  supplies: 'scarce' | 'normal' | 'plentiful';
  director: 'calm' | 'normal' | 'chaotic';
}

export function defaultDraft(): NewGameDraft {
  return { view: 'pick', catastrophe: 'storm', random: false, difficulty: 'normal', extra: [], supplies: 'normal', director: 'normal' };
}

export function draftOptions(d: NewGameDraft): Partial<NewGameOptions> {
  if (d.view === 'custom') {
    return { catastrophe: d.catastrophe, difficulty: d.difficulty, mode: 'sandbox', extra: d.extra.filter((x) => x !== d.catastrophe), supplies: d.supplies, director: d.director };
  }
  return { catastrophe: d.catastrophe, difficulty: d.difficulty, mode: 'survival', random: d.random };
}

function seg<T extends string>(name: string, value: T, opts: [T, string][]): string {
  return `<div class="seg" role="radiogroup" aria-label="${name}">${opts
    .map(([v, label]) => `<button role="radio" aria-checked="${v === value}" class="${v === value ? 'on' : ''}" data-a="draft" data-v="${name}|${v}">${label}</button>`)
    .join('')}</div>`;
}

function card(id: CatastropheId | 'random', selected: boolean): string {
  if (id === 'random') {
    return `<button class="scard random ${selected ? 'on' : ''}" data-a="draft" data-v="pick|random" style="--acc:#cfc6b4;--hz:#3a342c">
      <span class="vig">${icon('dice', 'big')}</span>
      <span class="sc-body"><span class="sc-kind">Surprise me</span><b>Random scenario</b><span class="sc-tag">The catastrophe is revealed when you arrive.</span></span>
    </button>`;
  }
  const d = CATASTROPHES[id];
  return `<button class="scard ${selected ? 'on' : ''}" data-a="draft" data-v="pick|${id}" style="--acc:${d.accent};--hz:${d.haze}">
    <span class="vig">${icon(SCENARIO_ICON[id], 'big')}</span>
    <span class="sc-body"><span class="sc-kind">${esc(d.kind)}</span><b>${esc(d.name)}</b><span class="sc-tag">${esc(d.tagline)}</span></span>
  </button>`;
}

export function scenarioSelectHtml(s: GameState, d: NewGameDraft): string {
  const inProgress = s.minute > START_MINUTE + 30 && !s.result;
  const warn = inProgress ? `<p class="tone-warn small">Starting a new game replaces your current settlement.</p>` : '';
  if (d.view === 'custom') {
    const main = CATASTROPHES[d.catastrophe];
    return `<div class="ph"><div><p class="kicker">Custom sandbox</p><h2>Build your own disaster</h2><p class="sub">Layer catastrophes, set the odds, and use sandbox controls mid-game from the World panel.</p></div><button class="x" data-a="modal-close" aria-label="Close">${icon('close')}</button></div>
      <h4>Main catastrophe</h4>
      <div class="chips">${CATASTROPHE_IDS.map((id) => `<button class="chipbtn ${d.catastrophe === id ? 'on' : ''}" data-a="draft" data-v="main|${id}" style="--acc:${CATASTROPHES[id].accent}">${icon(SCENARIO_ICON[id])}${esc(CATASTROPHES[id].name)}</button>`).join('')}</div>
      <p class="muted small">${esc(main.tagline)}</p>
      <h4>Layer on top</h4>
      <div class="chips">${CATASTROPHE_IDS.filter((id) => id !== d.catastrophe && id !== 'storm')
        .map((id) => `<button class="chipbtn ${d.extra.includes(id) ? 'on' : ''}" data-a="draft" data-v="extra|${id}" style="--acc:${CATASTROPHES[id].accent}">${icon(SCENARIO_ICON[id])}${esc(CATASTROPHES[id].name)}</button>`)
        .join('')}</div>
      <div class="opts">
        <label>Starting supplies</label>${seg('supplies', d.supplies, [['scarce', 'Scarce'], ['normal', 'Normal'], ['plentiful', 'Plentiful']])}
        <label>Crises</label>${seg('director', d.director, [['calm', 'Calm'], ['normal', 'Normal'], ['chaotic', 'Chaotic']])}
        <label>Difficulty</label>${seg('difficulty', d.difficulty, [['easy', 'Forgiving'], ['normal', 'Standard'], ['hard', 'Brutal']])}
      </div>
      ${warn}
      <div class="row"><button class="ghost" data-a="draft" data-v="view|pick">Back</button><button class="go big" data-a="begin">Begin sandbox</button></div>`;
  }
  const sel = d.random ? null : CATASTROPHES[d.catastrophe];
  const detail = sel
    ? `<div class="sc-detail" style="--acc:${sel.accent}"><b>${esc(sel.name)}</b><ul>${sel.pressures.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`
    : `<div class="sc-detail" style="--acc:#cfc6b4"><b>Random</b><ul><li>Any of the six catastrophes, chosen for you</li><li>You find out which in the opening briefing</li></ul></div>`;
  return `<div class="ph"><div><p class="kicker">New game · seven days</p><h2>Choose your catastrophe</h2></div><button class="x" data-a="modal-close" aria-label="Close">${icon('close')}</button></div>
    <div class="scards">${CATASTROPHE_IDS.map((id) => card(id, !d.random && d.catastrophe === id)).join('')}${card('random', d.random)}</div>
    ${detail}
    <div class="opts"><label>Difficulty</label>${seg('difficulty', d.difficulty, [['easy', 'Forgiving'], ['normal', 'Standard'], ['hard', 'Brutal']])}</div>
    <p class="muted small">${esc(difficultyInfo(d.difficulty).blurb)}</p>
    ${warn}
    <button class="go big" data-a="begin">${d.random ? 'Begin — random catastrophe' : `Begin — ${esc(sel!.name)}`}</button>
    <button class="lnk sandbox-link" data-a="draft" data-v="view|custom">${icon('sliders')}Custom sandbox</button>`;
}

// ---------------------------------------------------------------- world panel

function meter(label: string, value: number, max: number, text: string, tone: string): string {
  const w = Math.max(0, Math.min(100, (value / max) * 100));
  return `<div class="meter"><span>${label}</span><span class="mbar ${tone}"><span style="width:${w}%"></span></span><b>${text}</b></div>`;
}

export function warnings(s: GameState): { text: string; when: string }[] {
  const out: { text: string; when: string }[] = [];
  for (const p of s.world.director.pending) {
    const e = directorEvent(p.id);
    if (!e) continue;
    out.push({ text: e.title, when: p.at <= s.minute ? 'now' : `in ~${formatDuration(p.at - s.minute)}` });
  }
  const c = s.world.climax;
  if (!c.resolved && c.at < 8 * 24 * 60) {
    out.push({ text: c.label, when: c.known ? (s.minute >= c.at ? 'now' : `Day ${dayOf(c.at)} ${clockString(c.at)}`) : `~Day ${dayOf(c.at)}` });
  }
  return out;
}

export function worldPanelHtml(s: GameState): string {
  const def = CATASTROPHES[s.world.catastrophe];
  const w = s.world;
  let html = `<div class="ph"><div><p class="kicker" style="color:${def.accent}">${esc(def.kind)} · ${difficultyInfo(w.difficulty).label}${w.mode === 'sandbox' ? ' · sandbox' : ''}</p><h2>${esc(def.name)}</h2>${
    w.extra.length ? `<p class="sub">Also: ${w.extra.map((x) => esc(CATASTROPHES[x].name)).join(', ')}</p>` : ''
  }</div><button class="x" data-a="close-panel" aria-label="Close">${icon('close')}</button></div>`;
  // Current conditions.
  const rows: string[] = [];
  const rad = radiationNow(s);
  if (rad > 0) rows.push(meter('Radiation', rad, 15, `${rad.toFixed(1)} mSv/h`, rad > 6 ? 'bad' : rad > 2 ? 'warn' : 'ok'));
  const d = defense(s);
  if (isActive(s, 'outbreak')) {
    rows.push(meter('Infected', w.horde, 100, `${Math.round(w.horde)}`, w.horde > d.value * 6 ? 'bad' : 'warn'));
    rows.push(meter('Noise', w.noise, 100, `${Math.round(w.noise)}`, w.noise > 40 ? 'bad' : 'ok'));
  }
  if (isActive(s, 'collapse')) rows.push(meter('Ridge Crew', w.threat, 100, `${Math.round(w.threat)}`, w.threat >= 50 ? 'bad' : 'warn'));
  if (w.flood > 0.5 || isActive(s, 'quake')) rows.push(meter('Floodwater', w.flood, 100, `${Math.round(w.flood)}%`, w.flood > 40 ? 'bad' : 'ok'));
  if (isActive(s, 'pandemic')) {
    const sick = s.survivors.filter((x) => x.alive && x.illness?.kind === 'fever' && x.illness.stage === 'sick').length;
    rows.push(meter('Fever cases', sick, Math.max(1, presentSurvivors(s).length), `${sick} sick`, sick ? 'bad' : 'ok'));
  }
  if (isActive(s, 'collapse') || isActive(s, 'outbreak')) rows.push(meter('Defence', d.value, 12, `${d.value}`, 'ok'));
  if (rows.length) html += `<h4>Conditions</h4><div class="meters">${rows.join('')}</div>`;
  if ((isActive(s, 'collapse') || isActive(s, 'outbreak')) && d.parts.length) html += `<p class="muted small">Defence: ${d.parts.map(esc).join(' · ')}</p>`;
  if (rad > 0) html += `<p class="muted small">Indoors stops ~92% of it. Untreated water adds dose; boiling doesn’t help — filter it.</p>`;
  const warn = warnings(s);
  html += `<h4>Ahead</h4>${
    warn.length ? `<ul class="warns">${warn.map((x) => `<li>${icon('warn')}<span>${esc(x.text)}</span><em>${esc(x.when)}</em></li>`).join('')}</ul>` : '<p class="muted small">No warnings right now.</p>'
  }`;
  const places = (Object.keys(LOCATIONS) as LocationId[])
    .map((id) => {
      const r = w.routes[id];
      const h = locationHazard(s, id);
      const blocked = r && r.until > s.minute;
      const notes = [...(blocked ? [`blocked: ${r!.reason}`] : []), ...h.notes];
      return notes.length ? `<li><b>${esc(LOCATIONS[id].name)}</b><span class="${blocked ? 'tone-bad' : ''}">${notes.map(esc).join(' · ')}</span></li>` : '';
    })
    .filter(Boolean);
  if (places.length) html += `<h4>Out there</h4><ul class="places">${places.join('')}</ul>`;
  html += `<h4>This catastrophe</h4><ul class="pressures">${def.pressures.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
  if (w.mode === 'sandbox') html += sandboxHtml(s);
  return html;
}

function sandboxHtml(s: GameState): string {
  const w = s.world;
  const stepper = (key: 'radiation' | 'horde' | 'threat' | 'flood', label: string, stepBy: number, unit = '') =>
    `<div class="step"><span>${label}<small>${(w[key] as number).toFixed(key === 'radiation' ? 1 : 0)}${unit}</small></span><button data-a="sb-cond" data-v="${key}|${-stepBy}" aria-label="less">−</button><b>${(w[key] as number).toFixed(0)}</b><button data-a="sb-cond" data-v="${key}|${stepBy}" aria-label="more">+</button></div>`;
  const add = CATASTROPHE_IDS.filter((id) => !isActive(s, id));
  const events = triggerableEvents(s);
  return `<div class="sandbox"><h3>${icon('sliders')}Sandbox controls</h3>
    ${add.length ? `<h4>Add a catastrophe</h4><div class="chips">${add.map((id) => `<button class="chipbtn" data-a="sb-add" data-v="${id}" style="--acc:${CATASTROPHES[id].accent}">${icon(SCENARIO_ICON[id])}${esc(CATASTROPHES[id].name)}</button>`).join('')}</div>` : ''}
    <h4>World conditions</h4><div class="steps">${stepper('radiation', 'Radiation', 2, ' mSv/h')}${stepper('horde', 'Infected', 10)}${stepper('threat', 'Raider threat', 10)}${stepper('flood', 'Flood', 20, '%')}</div>
    <h4>Trigger an event</h4><div class="chips">${events.map((e) => `<button class="chipbtn" data-a="sb-event" data-v="${e.id}">${esc(e.title)}</button>`).join('')}</div>
    <h4>Weather & supplies</h4><div class="chips">
      <button class="chipbtn" data-a="sb-weather" data-v="squall">Squall</button><button class="chipbtn" data-a="sb-weather" data-v="rain">Rain</button><button class="chipbtn" data-a="sb-weather" data-v="clear">Clear skies</button>
      <button class="chipbtn" data-a="sb-supplies" data-v="some">+ Supplies</button><button class="chipbtn" data-a="sb-supplies" data-v="lots">+ Lots of supplies</button>
    </div></div>`;
}

/** One compact, always-visible pill summarising the catastrophe's main pressure. */
export function hazardPill(s: GameState): string {
  const def = CATASTROPHES[s.world.catastrophe];
  let text = def.name;
  let tone = '';
  const rad = radiationNow(s);
  const warn = warnings(s).find((w) => w.when === 'now' || w.when.startsWith('in'));
  if (s.survivors.some((x) => x.alive && x.trapped)) {
    text = 'Someone is trapped';
    tone = 'bad';
  } else if (warn) {
    text = `${warn.text} ${warn.when}`;
    tone = 'warn';
  } else if (rad > 0.5) {
    text = `${rad.toFixed(1)} mSv/h outdoors`;
    tone = rad > 6 ? 'bad' : 'warn';
  } else if (isActive(s, 'outbreak')) {
    const d = defense(s).value;
    text = `Infected ${Math.round(s.world.horde)} · defence ${d}`;
    tone = s.world.horde > d * 6 ? 'bad' : 'warn';
  } else if (isActive(s, 'collapse')) {
    text = `Ridge Crew threat ${Math.round(s.world.threat)}`;
    tone = s.world.threat >= 50 ? 'bad' : '';
  } else if (isActive(s, 'pandemic')) {
    const n = s.survivors.filter((x) => x.alive && x.illness?.kind === 'fever' && x.illness.stage === 'sick').length;
    text = n ? `${n} with fever` : 'No fever cases';
    tone = n ? 'bad' : '';
  } else if (s.world.flood > 1) {
    text = `Flood ${Math.round(s.world.flood)}%`;
    tone = 'warn';
  }
  return `<button class="alert hazard ${tone}" data-a="panel" data-v="world" style="--acc:${def.accent}">${icon(SCENARIO_ICON[s.world.catastrophe])}${esc(text)}</button>`;
}
