// warmup.ts — the per-mailbox/domain warmup ramp (M12 P5, 02/03; email-planning/13 P5). A new sending
// identity must never jump to full volume (the unforgiving deliverability risk, 13 §4.1): warmupDailyTarget
// returns the cap allowed on a given day of the ramp — a linear climb from a low start to the steady-state
// cap over rampDays. Pure + deterministic so the warmup tick (a leader-locked job like the sequence tick,
// 15 §A.4) and the deliverability dashboard both read the same schedule. The actual paced sending is enforced
// by the per-mailbox throttle on the send path (02, 15 §A.1); this is the SCHEDULE it reads.

export interface WarmupSchedule {
  /** Day-1 cap. */
  startPerDay?: number;
  /** Steady-state cap once warm. */
  capPerDay?: number;
  /** Days to climb from start → cap. */
  rampDays?: number;
}

const DEFAULTS = { startPerDay: 20, capPerDay: 200, rampDays: 30 } as const;

/** The send cap allowed on `daysSinceStart` of the ramp (day 0 = the start cap; >= rampDays = the full cap). */
export function warmupDailyTarget(daysSinceStart: number, schedule: WarmupSchedule = {}): number {
  const start = schedule.startPerDay ?? DEFAULTS.startPerDay;
  const cap = schedule.capPerDay ?? DEFAULTS.capPerDay;
  const ramp = schedule.rampDays ?? DEFAULTS.rampDays;
  if (daysSinceStart <= 0) return start;
  if (daysSinceStart >= ramp) return cap;
  return Math.round(start + (cap - start) * (daysSinceStart / ramp));
}

/** True once the identity has reached its steady-state cap (warmup complete). */
export function isWarmupComplete(daysSinceStart: number, schedule: WarmupSchedule = {}): boolean {
  return daysSinceStart >= (schedule.rampDays ?? DEFAULTS.rampDays);
}
