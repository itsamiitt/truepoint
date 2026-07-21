// deadLetter — the hand-built, PII-FREE dead-letter record (mirrors TruePoint deadLetter.ts, [S72][S74]).
// BullMQ has no built-in DLQ; on retry exhaustion a job is diverted here (scope + reason only, NEVER payload)
// for inspection/replay, and we alert on EXHAUSTION, not first failure [S102].
export interface DeadLetterRecord {
  queue: string;
  jobId: string;
  reason: string; // truncated error — no PII
  attemptsMade: number;
}

/** Returns a record ONLY on retry exhaustion (attemptsMade ≥ maxAttempts); null while retries remain. */
export function buildDeadLetter(input: {
  queue: string;
  jobId: string;
  error: string;
  attemptsMade: number;
  maxAttempts: number;
}): DeadLetterRecord | null {
  if (input.attemptsMade < input.maxAttempts) return null; // not dead yet — let BullMQ retry
  return {
    queue: input.queue,
    jobId: input.jobId,
    reason: input.error.slice(0, 200),
    attemptsMade: input.attemptsMade,
  };
}
