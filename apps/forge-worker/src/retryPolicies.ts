// retryPolicies — per-queue bounded retry + exponential backoff + jitter (mirrors TruePoint retryPolicies.ts,
// [S73]). Pure data (no env/Redis) so it is unit-testable. The sync egress gets the largest budget (a golden
// record must not be lost to a transient 5xx); maintenance the smallest (it re-runs anyway). Keyed by stage
// name (the register maps stage → forge-<stage> BullMQ queue).
export interface RetryPolicy {
  attempts: number;
  backoff: { type: "exponential"; delay: number; jitter: number };
}

const JITTER = 0.5;
const exp = (attempts: number, delay: number): RetryPolicy => ({
  attempts,
  backoff: { type: "exponential", delay, jitter: JITTER },
});

export const RETRY_POLICIES: Record<string, RetryPolicy> = {
  "capture-ingest": exp(3, 5_000),
  parse: exp(3, 5_000),
  "ai-extract": exp(3, 15_000),
  extract: exp(3, 15_000),
  resolve: exp(3, 10_000),
  verify: exp(3, 10_000),
  quality: exp(3, 10_000),
  sync: exp(5, 30_000), // egress gets the largest budget — never drop a golden record
  maintenance: exp(2, 60_000),
};

export function retryFor(queue: string): RetryPolicy {
  const policy = RETRY_POLICIES[queue];
  if (!policy) throw new Error(`no_retry_policy:${queue}`);
  return policy;
}
