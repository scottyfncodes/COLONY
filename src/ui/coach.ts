import { objectName } from '../sim/actions';
import { objectiveTarget } from '../sim/scenario';
import type { GameState } from '../sim/types';
import type { SpeedIndex } from '../sim/time';

// The first-game walkthrough: a handful of steps, each finished by doing the thing it asks.
// Steps watch the game rather than intercepting input, so the player is never trapped.

export interface CoachView {
  state: GameState;
  speed: SpeedIndex;
  panel: string | null;
  selectedObject: string | null;
  resOpen: string | null;
}

interface Step {
  id: string;
  text: (v: CoachView, c: Coach) => string;
  /** CSS selector of HUD elements to glow while this step is showing. */
  glow?: string;
  /** Show even while a bottom panel is open (on phones the card otherwise steps aside). */
  withPanel?: boolean;
  done: (v: CoachView, c: Coach) => boolean;
  skip?: (v: CoachView, c: Coach) => boolean;
}

const STEPS: Step[] = [
  {
    id: 'look',
    text: (v, c) => `This is your compound. The <b>gold arrow</b> marks what needs you most right now. Tap the <b>${c.targetName(v)}</b>.`,
    done: (v, c) => !!c.target && v.selectedObject === c.target,
    skip: (_v, c) => !c.target,
  },
  {
    id: 'queue',
    text: () => 'This card shows what’s wrong, what each fix costs and how long it takes. Tap <b>Queue job</b> on the first option.',
    glow: '#panel .act:first-of-type .go',
    withPanel: true,
    done: (v, c) => v.state.jobs.some((j) => j.targetId === c.target) || v.state.jobs.length > c.jobsAtStart,
    skip: (v) => v.panel !== 'object',
  },
  {
    id: 'watch',
    text: () => 'Someone walks to the supply cache for parts and a tool kit, then gets to work. Tap <b>▶▶</b> to speed up time.',
    glow: '#speed [data-v="2"], #speed [data-v="3"]',
    done: (v, c) => v.speed >= 2 || v.state.minute - c.stepStarted > 120,
  },
  {
    id: 'res',
    text: () => 'Your supplies are along the top: food, water, fuel, parts. <b>Tap any number</b> to see what it is and how fast it’s changing.',
    glow: '#res .chip',
    done: (v) => !!v.resOpen,
  },
  {
    id: 'people',
    text: () => 'Your survivors are along the bottom. The bars are <b>health, water, food and energy</b>. Tap someone to see how they’re doing.',
    glow: '#roster',
    done: (v) => v.panel === 'survivor',
  },
  {
    id: 'done',
    text: () => 'That’s the basics. The line at the top always names the most urgent problem. <b>Tap it to jump there.</b> Good luck.',
    done: () => false,
  },
];

export class Coach {
  step = 0;
  active = false;
  target: string | null = null;
  jobsAtStart = 0;
  stepStarted = 0;

  start(v: CoachView): void {
    this.active = true;
    this.step = 0;
    this.enter(v);
  }

  stop(): void {
    this.active = false;
  }

  private enter(v: CoachView): void {
    const t = objectiveTarget(v.state);
    if (this.step === 0) this.target = t?.kind === 'object' ? t.id : null;
    this.jobsAtStart = v.state.jobs.length;
    this.stepStarted = v.state.minute;
  }

  targetName(v: CoachView): string {
    const o = v.state.objects.find((x) => x.id === this.target);
    return o ? objectName(o).toLowerCase() : 'marked spot';
  }

  get last(): boolean {
    return this.step >= STEPS.length - 1;
  }

  /** Advance past finished or irrelevant steps. Returns true when the step changed. */
  tick(v: CoachView): boolean {
    if (!this.active) return false;
    let moved = false;
    for (let guard = 0; guard < STEPS.length; guard++) {
      const st = STEPS[this.step];
      if (!st || this.last) break;
      if (st.done(v, this) || st.skip?.(v, this)) {
        this.step++;
        this.enter(v);
        moved = true;
      } else break;
    }
    return moved;
  }

  html(v: CoachView): string {
    if (!this.active) return '';
    const st = STEPS[this.step];
    const dots = STEPS.map((_, i) => `<i class="${i === this.step ? 'on' : i < this.step ? 'done' : ''}"></i>`).join('');
    return `<div class="coach-card"><p>${st.text(v, this)}</p><div class="coach-foot"><span class="dots">${dots}</span>${
      this.last ? '<button class="go" data-a="coach-end">Got it</button>' : '<button class="lnk" data-a="coach-end">Skip tutorial</button>'
    }</div></div>`;
  }

  /** Whether the card should give way to an open panel. */
  yields(panelOpen: boolean): boolean {
    return panelOpen && !STEPS[this.step]?.withPanel;
  }

  glow(): string | undefined {
    return this.active ? STEPS[this.step]?.glow : undefined;
  }
}
