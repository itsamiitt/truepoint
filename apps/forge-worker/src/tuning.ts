// tuning — per-queue concurrency + processor deadline (mirrors TruePoint tuning.ts). Pure data. The AI-extract
// path is low-concurrency (seconds/call, spend-bound); resolve is serial-ish (ER cross-checks); maintenance is
// a singleton sweep. Keyed by stage name.
export const CONCURRENCY: Record<string, number> = {
  "capture-ingest": 8,
  parse: 8,
  "ai-extract": 4,
  extract: 4,
  resolve: 2,
  verify: 4,
  quality: 4,
  sync: 4,
  maintenance: 1,
};

export const PROCESSOR_DEADLINE_MS: Record<string, number> = {
  "capture-ingest": 10_000,
  parse: 15_000,
  "ai-extract": 60_000,
  extract: 60_000,
  resolve: 30_000,
  verify: 15_000,
  quality: 15_000,
  sync: 30_000,
  maintenance: 120_000,
};

export function concurrencyFor(queue: string): number {
  return CONCURRENCY[queue] ?? 1;
}

export function deadlineFor(queue: string): number {
  const ms = PROCESSOR_DEADLINE_MS[queue];
  if (!ms) throw new Error(`no_deadline:${queue}`);
  return ms;
}
