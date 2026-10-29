// Procedural Web Audio engine: one-shot UI/game cues plus ambience driven by GameState.
// No audio files; everything is synthesized. Every entry point is a safe no-op without Web Audio.
import type { CatastropheId, GameState } from '../sim/types';
import { darkness } from '../sim/time';

export type Cue =
  | 'tap' | 'open' | 'close' | 'queue' | 'build' | 'complete' | 'good' | 'warn'
  | 'bad' | 'event' | 'climax' | 'death' | 'day' | 'place' | 'error';

const MASTER = 0.5;
const SMOOTH = 0.35; // setTargetAtTime constant for ambience (s)
const MIN_GAP: Partial<Record<Cue, number>> = { bad: 1.5, warn: 1.5, event: 0.8, climax: 3, death: 1, day: 2 };

type Ctor = typeof AudioContext;

interface Drone {
  a: OscillatorNode;
  b: OscillatorNode;
  filter: BiquadFilterNode;
  trem: GainNode;
  lfo: OscillatorNode;
  lfoDepth: GainNode;
  gain: GainNode;
}

export class SoundEngine {
  muted: boolean;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private amb: GainNode | null = null;
  private sfx: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private rainGain: GainNode | null = null;
  private humGain: GainNode | null = null;
  private drone: Drone | null = null;
  private droneKind: CatastropheId | null = null;
  private last: Partial<Record<Cue, number>> = {};
  private hidden = false;
  private failed = false;
  private acc = 0; // throttle for param updates
  private gust = 0;
  private gustTarget = 0;
  private gustTimer = 0;
  private cricketTimer = 2;
  private workTimer = 1;
  private tickTimer = 0.5;
  private tension = 0;
  private droneIdle = 0;

  constructor(muted = false) {
    this.muted = muted;
  }

  unlock(): void {
    try {
      if (!this.ctx) this.init();
      const ctx = this.ctx;
      if (!ctx) return;
      if (ctx.state !== 'running' && !this.hidden) void ctx.resume().catch(() => undefined);
      // iOS: a buffer started inside the gesture unlocks output.
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      /* ignore */
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (!this.ctx || !this.master) return;
    try {
      this.master.gain.setTargetAtTime(m ? 0 : MASTER, this.ctx.currentTime, 0.08);
    } catch {
      /* ignore */
    }
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      if (hidden && ctx.state === 'running') void ctx.suspend().catch(() => undefined);
      else if (!hidden && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  play(cue: Cue): void {
    const ctx = this.ctx;
    if (!ctx || this.muted || ctx.state !== 'running') return;
    try {
      const now = ctx.currentTime;
      const prev = this.last[cue];
      if (prev !== undefined && now - prev < (MIN_GAP[cue] ?? 0.06)) return;
      this.last[cue] = now;
      this.cue(cue, now + 0.005);
    } catch {
      /* ignore */
    }
  }

  update(state: GameState, dt: number, speed: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.amb) return;
    try {
      this.tick(state, Math.min(0.25, Math.max(0, dt)), speed, ctx);
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- setup

  private init(): void {
    if (this.failed || typeof window === 'undefined') return;
    try {
      const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
      const C = w.AudioContext ?? w.webkitAudioContext;
      if (!C) {
        this.failed = true;
        return;
      }
      const ctx = new C();
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 4;
      comp.connect(ctx.destination);
      this.master = this.gain(this.muted ? 0 : MASTER, comp);
      this.amb = this.gain(1, this.master);
      this.sfx = this.gain(0.9, this.master);

      const len = Math.floor(ctx.sampleRate * 2);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;

      // Wind
      this.windGain = this.gain(0, this.amb);
      this.windFilter = ctx.createBiquadFilter();
      this.windFilter.type = 'bandpass';
      this.windFilter.frequency.value = 400;
      this.windFilter.Q.value = 0.8;
      this.windFilter.connect(this.windGain);
      this.loopNoise(0).connect(this.windFilter);

      // Rain
      this.rainGain = this.gain(0, this.amb);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2200;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 9000;
      hp.connect(lp).connect(this.rainGain);
      this.loopNoise(0.9).connect(hp);

      // Generator hum
      this.humGain = this.gain(0, this.amb);
      const humLp = ctx.createBiquadFilter();
      humLp.type = 'lowpass';
      humLp.frequency.value = 220;
      humLp.connect(this.humGain);
      const wob = ctx.createOscillator();
      wob.frequency.value = 0.7;
      const wobDepth = this.gain(4, null);
      wob.connect(wobDepth);
      for (const [f, type, v] of [[48, 'sawtooth', 0.5], [96, 'sine', 0.35], [144, 'triangle', 0.15]] as const) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        wobDepth.connect(o.detune);
        o.connect(this.gain(v, humLp));
        o.start();
      }
      wob.start();
    } catch {
      this.failed = true;
      this.ctx = null;
    }
  }

  private gain(v: number, to: AudioNode | null): GainNode {
    const g = this.ctx!.createGain();
    g.gain.value = v;
    if (to) g.connect(to);
    return g;
  }

  private loopNoise(offset: number): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start(0, offset);
    return src;
  }

  private set(p: AudioParam, v: number, tc = SMOOTH): void {
    p.setTargetAtTime(v, this.ctx!.currentTime, tc);
  }

  // ------------------------------------------------------------ ambience

  private tick(s: GameState, dt: number, speed: number, ctx: AudioContext): void {
    const w = s.weather;
    const storm = w.kind === 'storm';
    const working = speed > 0 ? s.jobs.reduce((n, j) => n + (j.phase === 'work' ? 1 : 0), 0) : 0;
    const quiet = this.muted;

    // Gusting: wander toward a new random target every few seconds.
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) {
      this.gustTimer = 1.5 + Math.random() * 4;
      this.gustTarget = Math.random() * (storm ? 1 : 0.6);
    }
    this.gust += (this.gustTarget - this.gust) * Math.min(1, dt * 0.8);

    // Event-ish one-shots (scheduled from real time).
    const night = darkness(s.minute) > 0.6 && w.rain < 0.05;
    if (!quiet && night) {
      this.cricketTimer -= dt;
      if (this.cricketTimer <= 0) {
        this.cricketTimer = 0.8 + Math.random() * 3.5;
        this.cricket(ctx.currentTime + 0.01);
      }
    }
    if (!quiet && working > 0) {
      this.workTimer -= dt * (1 + Math.min(4, working - 1) * 0.25);
      if (this.workTimer <= 0) {
        this.workTimer = 0.6 + Math.random() * 1.6;
        this.clink(ctx.currentTime + 0.01);
      }
    }
    const c = s.world.climax;
    const live = s.minute >= c.at && !c.resolved;
    const close = !c.resolved && c.at - s.minute < 6 * 60;
    this.tension = live ? 1 : close ? 0.35 + 0.65 * (1 - Math.max(0, c.at - s.minute) / 360) : 0;
    if (!quiet && this.tension > 0.05 && s.world.catastrophe === 'fallout') {
      this.tickTimer -= dt;
      if (this.tickTimer <= 0) {
        this.tickTimer = 0.04 + Math.random() * (0.6 - 0.45 * this.tension);
        this.noiseHit(ctx.currentTime + 0.01, 0.006, 3500, 2, 0.12 * this.tension, this.amb!);
      }
    }

    // Parameter updates at ~10 Hz.
    this.acc += dt;
    if (this.acc < 0.1) return;
    this.acc = 0;

    const duck = speed === 0 || s.events.pending ? 0.4 : 1;
    this.set(this.amb!.gain, duck, 0.25);

    const wind = Math.min(1, w.wind * (0.7 + 0.6 * this.gust));
    this.set(this.windGain!.gain, (storm ? 0.32 : 0.12) * wind + 0.01);
    this.set(this.windFilter!.frequency, 250 + wind * (storm ? 900 : 600));
    this.set(this.rainGain!.gain, 0.16 * Math.min(1, w.rain) * (storm ? 1.3 : 1));

    const gen = s.objects.some((o) => o.type === 'generator' && !!o.data.running);
    this.set(this.humGain!.gain, gen ? 0.035 : 0, 0.6);

    if (this.tension > 0.05) {
      if (!this.drone || this.droneKind !== s.world.catastrophe) this.makeDrone(s.world.catastrophe);
    }
    if (this.drone) {
      this.set(this.drone.gain.gain, 0.07 * this.tension, 1.2);
      this.droneIdle = this.tension <= 0.05 ? this.droneIdle + 0.1 : 0;
      if (this.droneIdle > 8) this.killDrone(0);
    }
  }

  private makeDrone(kind: CatastropheId): void {
    const ctx = this.ctx!;
    if (this.drone) this.killDrone(2);
    const [f, type, cutoff, lfoHz, depth]: [number, OscillatorType, number, number, number] =
      kind === 'pandemic' ? [660, 'sine', 2400, 0.25, 0.3]
        : kind === 'collapse' ? [55, 'sawtooth', 260, 1.6, 0.7]
          : kind === 'outbreak' ? [62, 'sawtooth', 320, 0.18, 0.6]
            : kind === 'fallout' ? [73, 'triangle', 500, 0.1, 0.15]
              : [41, 'sawtooth', 180, 0.07, 0.25]; // storm, quake: dark rumble
    const gain = this.gain(0, this.amb);
    const trem = this.gain(1 - depth / 2, gain);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    filter.Q.value = 2;
    filter.connect(trem);
    const a = ctx.createOscillator();
    const b = ctx.createOscillator();
    a.type = b.type = type;
    a.frequency.value = f;
    b.frequency.value = f;
    b.detune.value = kind === 'pandemic' ? 31 : 13;
    a.connect(filter);
    b.connect(filter);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = lfoHz;
    const lfoDepth = this.gain(depth / 2, null);
    lfoDepth.connect(trem.gain);
    lfo.connect(lfoDepth);
    a.start();
    b.start();
    lfo.start();
    this.drone = { a, b, filter, trem, lfo, lfoDepth, gain };
    this.droneKind = kind;
  }

  private killDrone(fade: number): void {
    const d = this.drone;
    if (!d) return;
    const t = this.ctx!.currentTime;
    d.gain.gain.setTargetAtTime(0, t, fade / 4 + 0.01);
    for (const o of [d.a, d.b, d.lfo]) o.stop(t + fade + 0.1);
    this.drone = null;
    this.droneKind = null;
  }

  // -------------------------------------------------------------- voices

  private tone(t: number, f: number, dur: number, vol: number, type: OscillatorType = 'sine', f2?: number, att = 0.01): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + att);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfx!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noiseHit(t: number, dur: number, freq: number, q: number, vol: number, to: AudioNode, type: BiquadFilterType = 'bandpass'): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(to);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.02);
  }

  private cricket(t: number): void {
    const f = 4200 + Math.random() * 600;
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) this.ambTone(t + i * 0.07, f, 0.04, 0.012);
  }

  private clink(t: number): void {
    if (Math.random() < 0.5) this.noiseHit(t, 0.08, 1800 + Math.random() * 2400, 12, 0.08, this.amb!);
    else this.ambTone(t, 900 + Math.random() * 900, 0.12, 0.025, 'triangle');
  }

  private ambTone(t: number, f: number, dur: number, vol: number, type: OscillatorType = 'sine'): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.amb!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private cue(c: Cue, t: number): void {
    const sfx = this.sfx!;
    switch (c) {
      case 'tap': return this.noiseHit(t, 0.025, 3000, 1.5, 0.08, sfx);
      case 'open': return this.tone(t, 520, 0.09, 0.06, 'sine', 780);
      case 'close': return this.tone(t, 700, 0.09, 0.05, 'sine', 440);
      case 'queue':
        this.tone(t, 660, 0.09, 0.07, 'triangle');
        return this.tone(t + 0.08, 990, 0.14, 0.07, 'triangle');
      case 'build':
      case 'place':
        this.tone(t, c === 'build' ? 140 : 180, 0.18, 0.18, 'sine', 60);
        return this.noiseHit(t, 0.06, 600, 1, 0.12, sfx, 'lowpass');
      case 'complete':
        [523, 659, 784].forEach((f, i) => this.tone(t + i * 0.09, f, 0.5, 0.07, 'triangle'));
        return;
      case 'good':
        [784, 988, 1175].forEach((f) => this.tone(t, f, 0.7, 0.04, 'sine', undefined, 0.02));
        return;
      case 'warn':
        this.tone(t, 392, 0.18, 0.08, 'triangle');
        return this.tone(t + 0.2, 330, 0.25, 0.08, 'triangle');
      case 'bad':
        this.tone(t, 220, 0.5, 0.07, 'sawtooth', 196);
        this.tone(t, 233, 0.5, 0.06, 'sawtooth', 207);
        return this.tone(t + 0.02, 110, 0.6, 0.1, 'sine');
      case 'event':
        this.tone(t, 440, 0.8, 0.06, 'triangle', 660, 0.35);
        return this.tone(t, 554, 0.8, 0.04, 'sine', 830, 0.35);
      case 'climax':
        this.tone(t, 70, 1.6, 0.35, 'sine', 32);
        this.noiseHit(t, 1.2, 180, 0.7, 0.35, sfx, 'lowpass');
        this.tone(t + 0.1, 110, 2.2, 0.06, 'sawtooth', 165, 1.2);
        return this.tone(t + 0.1, 131, 2.2, 0.05, 'sawtooth', 196, 1.2);
      case 'death':
        [220, 262, 330].forEach((f) => this.tone(t, f, 2.4, 0.045, 'triangle', f * 0.94, 0.4));
        return;
      case 'day':
        this.tone(t, 880, 1.8, 0.05, 'sine', undefined, 0.005);
        this.tone(t, 2210, 1.0, 0.015, 'sine', undefined, 0.005);
        return this.tone(t + 0.25, 1320, 1.5, 0.03, 'sine', undefined, 0.005);
      case 'error':
        return this.tone(t, 110, 0.14, 0.07, 'square', 98);
    }
  }
}
