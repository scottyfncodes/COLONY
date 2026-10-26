// Simulation time. One tick = one game minute; the sim never depends on frame rate.
export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 24 * 60;
export const START_MINUTE = 7 * 60; // Day 1, 07:00
export const SCENARIO_DAYS = 7;
export const END_MINUTE = SCENARIO_DAYS * MINUTES_PER_DAY; // end of Day 7

/** Game minutes simulated per real second, indexed by speed (pause, 1x, 3x, 9x). */
export const SPEEDS = [0, 4, 12, 36] as const;
export type SpeedIndex = 0 | 1 | 2 | 3;

export function dayOf(minute: number): number {
  return Math.floor(minute / MINUTES_PER_DAY) + 1;
}

export function hourOf(minute: number): number {
  return Math.floor((minute % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
}

export function minuteOfDay(minute: number): number {
  return minute % MINUTES_PER_DAY;
}

export function clockString(minute: number): string {
  const h = hourOf(minute);
  const m = Math.floor(minute % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function isNight(minute: number): boolean {
  const h = hourOf(minute);
  return h >= 21 || h < 6;
}

/** 0 = full daylight, 1 = darkest night. Smooth dusk/dawn ramps. */
export function darkness(minute: number): number {
  const t = minuteOfDay(minute) / 60; // hours, fractional
  if (t >= 7 && t <= 18) return 0;
  if (t > 18 && t < 21) return (t - 18) / 3;
  if (t >= 21 || t < 4.5) return 1;
  return 1 - (t - 4.5) / 2.5; // 4.5 -> 7 dawn
}

export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  if (h > 0) return r ? `${h}h ${r}m` : `${h}h`;
  return `${r}m`;
}
