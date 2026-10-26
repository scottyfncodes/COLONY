import { CATASTROPHES, CATASTROPHE_IDS, isActive, scheduleSquall } from './catastrophes';
import { directorEvent, DIRECTOR_EVENTS, startEvent } from './director';
import { log, produce } from './inventory';
import type { CommandResult, GameState, SandboxAction } from './types';

// Sandbox interventions. Every action is validated and clamped so it can only
// produce states the normal simulation could also reach; survival games refuse them.

const LIMITS = { radiation: [0, 20], horde: [0, 100], threat: [0, 100], flood: [0, 100] } as const;

/** Director events a sandbox player may trigger right now (their basic preconditions hold). */
export function triggerableEvents(s: GameState) {
  return DIRECTOR_EVENTS.filter((e) => {
    switch (e.id) {
      case 'aftershock':
        return isActive(s, 'quake');
      case 'nightRaid':
        return isActive(s, 'collapse');
      case 'breach':
        return isActive(s, 'outbreak');
      case 'genFailure': {
        const g = s.objects.find((o) => o.type === 'generator');
        return !!g && g.state === 'operational';
      }
      case 'desertion':
        return s.survivors.some((x) => x.alive && !x.away && !x.trapped);
      case 'thief':
        return false;
      case 'supplyDrop':
        return true;
      default:
        return true;
    }
  });
}

export function runSandbox(s: GameState, a: SandboxAction): CommandResult {
  if (s.world.mode !== 'sandbox') return { ok: false, message: 'Sandbox controls are only available in sandbox games.' };
  switch (a.kind) {
    case 'addCatastrophe': {
      if (!CATASTROPHE_IDS.includes(a.catastrophe)) return { ok: false, message: 'Unknown catastrophe.' };
      if (isActive(s, a.catastrophe)) return { ok: false, message: `${CATASTROPHES[a.catastrophe].name} is already happening.` };
      s.world.extra.push(a.catastrophe);
      CATASTROPHES[a.catastrophe].inject(s);
      return { ok: true, message: `${CATASTROPHES[a.catastrophe].name} added.` };
    }
    case 'setCondition': {
      const lim = LIMITS[a.key];
      if (!lim || !Number.isFinite(a.value)) return { ok: false, message: 'Invalid condition.' };
      s.world[a.key] = Math.max(lim[0], Math.min(lim[1], a.value));
      return { ok: true, message: `${a.key} set to ${s.world[a.key]}.` };
    }
    case 'triggerEvent': {
      const e = directorEvent(a.eventId);
      if (!e || !triggerableEvents(s).includes(e)) return { ok: false, message: 'That event can’t happen right now.' };
      if (a.eventId === 'desertion') {
        // Pick the unhappiest person so the event has a valid subject.
        const v = s.survivors.filter((x) => x.alive && !x.away && !x.trapped).sort((p, q) => p.morale - q.morale)[0];
        v.morale = Math.min(v.morale, 20);
      }
      const ok = startEvent(s, e);
      return ok ? { ok: true, message: `${e.title}: under way.` } : { ok: false, message: 'Nothing happened.' };
    }
    case 'weather': {
      if (s.weather.kind === 'storm') return { ok: false, message: 'A storm is already raging.' };
      if (a.weather === 'clear') {
        s.weather.rainWindows = s.weather.rainWindows.filter((r) => r.end <= s.minute || r.start > s.minute);
        return { ok: true, message: 'The skies clear.' };
      }
      if (a.weather === 'squall') scheduleSquall(s, 3 * 60);
      else s.weather.rainWindows.push({ start: s.minute, end: s.minute + 4 * 60 });
      log(s, a.weather === 'squall' ? 'A squall blows in.' : 'Rain begins to fall.', 'info');
      return { ok: true, message: a.weather === 'squall' ? 'Squall incoming.' : 'Rain for four hours.' };
    }
    case 'supplies': {
      const k = a.amount === 'lots' ? 3 : 1;
      produce(s, { scrap: 6 * k, mech: 2 * k, elec: 2 * k, food: 6 * k, water: 20 * k, fuel: 4 * k, meds: 2 * k });
      return { ok: true, message: 'Supplies delivered to storage (as far as there is room).' };
    }
  }
  return { ok: false, message: 'Unknown sandbox action.' };
}
