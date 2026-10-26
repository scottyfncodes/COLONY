import './style.css';
import { blueprint } from './sim/actions';
import { dispatch, isPaused, newGame, step, validatePlacement } from './sim/sim';
import { clearSave, loadFrom, saveTo } from './sim/save';
import { SPEEDS, type SpeedIndex } from './sim/time';
import type { Command, CommandResult, GameState, ObjectType } from './sim/types';
import { Renderer, type ViewState } from './render/renderer';
import { injectIcons } from './ui/icons';
import { UI, type Controller, type ModalKind, type PanelKind } from './ui/ui';

/** localStorage can be missing or throw (private mode, sandboxed frames); fall back to memory. */
const store: Storage = (() => {
  try {
    const ls = window.localStorage;
    ls.setItem('colony.probe', '1');
    ls.removeItem('colony.probe');
    return ls;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    } as Storage;
  }
})();

class Game implements Controller {
  state: GameState;
  view: ViewState = { selectedSurvivor: null, selectedObject: null, ghost: null, hover: null };
  speed: SpeedIndex = 1;
  panel: PanelKind = null;
  modal: ModalKind = null;
  placing: ObjectType | null = null;
  assignee: string | null = null;
  saveStatus = 'Autosaves to this browser';
  renderer: Renderer;
  ui: UI;
  private acc = 0;
  private last = 0;
  private lastUi = 0;
  private lastSave = 0;

  constructor(private root: HTMLElement, canvas: HTMLCanvasElement) {
    const loaded = loadFrom(store);
    let note = '';
    if (loaded.ok) {
      this.state = loaded.state;
      note = 'Welcome back — your settlement was restored.';
    } else {
      if (loaded.reason !== 'No save found.') note = `${loaded.reason} Starting a fresh game.`;
      this.state = newGame();
    }
    this.renderer = new Renderer(canvas);
    this.ui = new UI(root, this);
    this.resize();
    const small = window.innerWidth < 760;
    this.renderer.camera.zoom = small ? 0.6 : 1.05;
    this.renderer.camera.centerOn(small ? 14 : 15.5, small ? 13 : 14);
    if (note) setTimeout(() => this.ui.toast(note, loaded.ok), 400);
    this.bindInput(canvas);
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && this.save());
    window.addEventListener('pagehide', () => this.save());
    requestAnimationFrame((t) => this.frame(t));
  }

  resize(): void {
    this.renderer.resize(this.root.clientWidth, this.root.clientHeight);
  }

  save(): void {
    const ok = saveTo(store, this.state);
    this.saveStatus = ok ? 'Autosaved to this browser' : 'Saving unavailable (private mode?)';
  }

  // ------------------------------------------------------------ loop

  private frame(t: number): void {
    const dt = Math.min(0.25, this.last ? (t - this.last) / 1000 : 0);
    this.last = t;
    if (!isPaused(this.state) && this.speed > 0) {
      this.acc += dt * SPEEDS[this.speed];
      let n = 0;
      while (this.acc >= 1 && n < 240) {
        this.renderer.snapshot(this.state);
        step(this.state);
        this.acc -= 1;
        n++;
        if (isPaused(this.state)) {
          this.acc = 0;
          break;
        }
      }
    }
    this.renderer.render(this.state, this.view, Math.min(1, this.acc), t);
    if (t - this.lastUi > 180) {
      this.lastUi = t;
      this.ui.update();
    }
    if (t - this.lastSave > 15000) {
      this.lastSave = t;
      this.save();
    }
    requestAnimationFrame((tt) => this.frame(tt));
  }

  // ------------------------------------------------------------ controller API

  command(cmd: Command): CommandResult {
    const r = dispatch(this.state, cmd);
    if (r.ok) this.ui.update(true);
    return r;
  }

  setSpeed(i: SpeedIndex): void {
    this.speed = i;
  }

  /** On phones the bottom sheet covers half the view: keep the focus point in the visible upper area. */
  private reveal(tx: number, ty: number): void {
    if (this.root.clientWidth >= 760) return;
    const cam = this.renderer.camera;
    const p = cam.toScreen((tx - ty) * 32, (tx + ty) * 16);
    const limit = cam.height * 0.4;
    const dx = p.x < 40 || p.x > cam.width - 40 ? cam.width / 2 - p.x : 0;
    const dy = p.y > limit || p.y < 140 ? cam.height * 0.3 - p.y : 0;
    if (dx || dy) cam.pan(dx, dy);
  }

  focus(tx: number, ty: number): void {
    this.renderer.camera.centerOn(tx, ty);
    this.reveal(tx, ty);
  }

  selectSurvivor(id: string | null): void {
    const s = this.state.survivors.find((x) => x.id === id);
    if (s && !s.away && s.alive) this.reveal(s.x, s.y);
    this.view.selectedSurvivor = id;
    this.view.selectedObject = null;
    this.assignee = id;
    this.panel = id ? 'survivor' : null;
  }

  selectObject(id: string | null): void {
    const o = this.state.objects.find((x) => x.id === id);
    if (o) this.reveal(o.x + o.w / 2, o.y + o.h / 2);
    this.view.selectedObject = id;
    if (id) this.panel = 'object';
  }

  openPanel(p: PanelKind): void {
    this.panel = p;
    if (!p) {
      this.view.selectedObject = null;
      this.view.selectedSurvivor = null;
      this.assignee = null;
    }
  }

  openModal(m: ModalKind): void {
    this.modal = m;
  }

  startPlacing(t: ObjectType): void {
    this.placing = t;
    this.view.ghost = null;
    this.ui.ghostReason = null;
  }

  confirmPlacing(): void {
    const g = this.view.ghost;
    if (!g || !this.placing) return;
    const r = this.command({ type: 'build', blueprint: this.placing, x: g.x, y: g.y, assigneeId: this.assignee });
    this.ui.toast(r.message, r.ok);
    if (r.ok) {
      this.placing = null;
      this.view.ghost = null;
      this.panel = null;
    }
  }

  cancelPlacing(): void {
    this.placing = null;
    this.view.ghost = null;
  }

  centerOnSurvivor(id: string): void {
    const s = this.state.survivors.find((x) => x.id === id);
    if (s && !s.away) this.focus(s.x, s.y);
  }

  centerOnObject(id: string): void {
    const o = this.state.objects.find((x) => x.id === id);
    if (o) this.focus(o.x + o.w / 2, o.y + o.h / 2);
  }

  newGame(): void {
    clearSave(store);
    this.state = newGame();
    this.view = { selectedSurvivor: null, selectedObject: null, ghost: null, hover: null };
    this.panel = null;
    this.modal = null;
    this.placing = null;
    this.assignee = null;
    this.speed = 1;
    this.ui.resetEnd();
    this.save();
    this.ui.update(true);
  }

  /** Debug/test helper: advance the simulation, stopping at decisions. Returns minutes simulated. */
  advance(minutes: number): number {
    let n = 0;
    for (; n < minutes && !isPaused(this.state); n++) {
      this.renderer.snapshot(this.state);
      step(this.state);
    }
    this.ui.update(true);
    return n;
  }

  /** Debug/test helper: screen position of a tile point. */
  screenOf(x: number, y: number, z = 0): { x: number; y: number } {
    return this.renderer.camera.toScreen((x - y) * 32, (x + y) * 16 - z);
  }

  // ------------------------------------------------------------ world input

  private tap(sx: number, sy: number): void {
    if (this.state.events.pending) return;
    const cam = this.renderer.camera;
    if (this.placing) {
      const bp = blueprint(this.placing)!;
      const t = cam.tileAt(sx, sy);
      const x = Math.floor(t.x - (bp.w - 1) / 2);
      const y = Math.floor(t.y - (bp.h - 1) / 2);
      const g = this.view.ghost;
      if (g && g.x === x && g.y === y && g.valid) {
        this.confirmPlacing();
        return;
      }
      const why = validatePlacement(this.state, this.placing, x, y);
      this.view.ghost = { type: this.placing, x, y, valid: !why };
      this.ui.ghostReason = why;
      this.ui.update(true);
      return;
    }
    const p = this.renderer.pick(this.state, sx, sy);
    if (p.kind === 'survivor') {
      this.selectSurvivor(p.id);
    } else if (p.kind === 'object') {
      this.selectObject(p.id);
    } else if (this.view.selectedSurvivor) {
      const s = this.state.survivors.find((x) => x.id === this.view.selectedSurvivor);
      if (s && s.alive && !s.away) {
        const r = this.command({ type: 'move', survivorId: s.id, x: p.x, y: p.y });
        this.ui.toast(r.message, r.ok);
      }
    } else {
      this.openPanel(null);
    }
    this.ui.update(true);
  }

  private bindInput(canvas: HTMLCanvasElement): void {
    const cam = this.renderer.camera;
    const pts = new Map<number, { x: number; y: number }>();
    let start: { x: number; y: number; t: number } | null = null;
    let dragged = false;
    let pinch: { d: number; mx: number; my: number } | null = null;
    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size === 1) {
        start = { ...p, t: performance.now() };
        dragged = false;
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        dragged = true;
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = local(e);
      if (e.pointerType === 'mouse' && !pts.size) {
        const t = cam.tileAt(p.x, p.y);
        this.view.hover = { x: Math.floor(t.x), y: Math.floor(t.y) };
        if (this.placing) {
          const bp = blueprint(this.placing)!;
          const x = Math.floor(t.x - (bp.w - 1) / 2);
          const y = Math.floor(t.y - (bp.h - 1) / 2);
          if (!this.view.ghost || this.view.ghost.x !== x || this.view.ghost.y !== y) {
            const why = validatePlacement(this.state, this.placing, x, y);
            this.view.ghost = { type: this.placing, x, y, valid: !why };
            this.ui.ghostReason = why;
          }
        }
        return;
      }
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      pts.set(e.pointerId, p);
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        cam.pan(mx - pinch.mx, my - pinch.my);
        if (pinch.d > 0) cam.zoomAt(d / pinch.d, mx, my);
        pinch = { d, mx, my };
        return;
      }
      if (start && (dragged || Math.hypot(p.x - start.x, p.y - start.y) > 7)) {
        dragged = true;
        cam.pan(p.x - prev.x, p.y - prev.y);
      }
    });
    const end = (e: PointerEvent) => {
      const had = pts.has(e.pointerId);
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (!had) return;
      if (pts.size === 0 && start && !dragged && performance.now() - start.t < 600 && e.type === 'pointerup') {
        const p = local(e);
        this.tap(p.x, p.y);
      }
      if (pts.size === 0) start = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => (this.view.hover = null));
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        cam.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );
    // Stop Safari's own pinch-zoom and double-tap zoom on the page.
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());
    const keys = new Set<string>();
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'SELECT') return;
      keys.add(e.key.toLowerCase());
      switch (e.key) {
        case ' ':
          e.preventDefault();
          this.speed = this.speed === 0 ? 1 : 0;
          break;
        case '1':
        case '2':
        case '3':
          this.speed = Number(e.key) as SpeedIndex;
          break;
        case 'Escape':
          if (this.placing) this.cancelPlacing();
          else if (this.modal) this.modal = null;
          else this.openPanel(null);
          break;
        case 'b':
          this.openPanel(this.panel === 'build' ? null : 'build');
          break;
        case 'j':
          this.openPanel(this.panel === 'jobs' ? null : 'jobs');
          break;
        case 'e':
          this.modal = this.modal === 'expedition' ? null : 'expedition';
          break;
        case 'l':
          this.openPanel(this.panel === 'log' ? null : 'log');
          break;
        case '+':
        case '=':
          cam.zoomAt(1.15, cam.width / 2, cam.height / 2);
          break;
        case '-':
          cam.zoomAt(1 / 1.15, cam.width / 2, cam.height / 2);
          break;
      }
      this.ui.update(true);
    });
    window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => keys.clear());
    const panLoop = () => {
      const sp = 12;
      let dx = 0;
      let dy = 0;
      if (keys.has('w') || keys.has('arrowup')) dy += sp;
      if (keys.has('s') || keys.has('arrowdown')) dy -= sp;
      if (keys.has('a') || keys.has('arrowleft')) dx += sp;
      if (keys.has('d') || keys.has('arrowright')) dx -= sp;
      if (dx || dy) cam.pan(dx, dy);
      requestAnimationFrame(panLoop);
    };
    requestAnimationFrame(panLoop);
  }
}

injectIcons();
const root = document.getElementById('app')!;
const canvas = document.getElementById('world') as HTMLCanvasElement;
const game = new Game(root, canvas);
// Exposed for automated browser tests and debugging.
(window as unknown as { __colony: Game }).__colony = game;
