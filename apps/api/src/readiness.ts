// readiness.ts — the dependency-probing half of the API's health surface (L-1.10).
//
// Why this is separate from /health. `/health` is LIVENESS: is this process alive and not draining. It
// deliberately does not touch Postgres, because coupling liveness to a dependency is how a single database
// blip turns into a fleet-wide restart storm — every replica fails its probe at the same instant, and the
// orchestrator recycles all of them while the database is already struggling. Readiness is the opposite
// question — "can this process serve traffic right now" — and the correct response to a no is to stop
// routing to it, not to kill it. So: /health stays cheap and local, /ready probes.
//
// This mirrors apps/workers/src/health.ts, which already got this right, including the two properties that
// make a probe safe:
//
//   1. BOUNDED. A wedged dependency must make the probe resolve false, never hang. A hanging probe is worse
//      than a failing one: the orchestrator's own timeout fires, and until it does the process looks fine.
//   2. THRESHOLDED. One transient failure must not flip the replica out of rotation. Without a consecutive-
//      failure threshold, a 50ms network hiccup during a probe de-rotates a healthy process — and if every
//      replica probes on the same interval, all of them at once.

import { pingDb } from "@leadwolf/db";

/** A bounded, never-throwing reachability check. Must resolve false — not hang, not throw — when the
 *  dependency is wedged. Same contract as the workers' ReadinessProbe. */
export type ReadinessProbe = () => Promise<boolean>;

/** Consecutive probe failures before /ready reports not-ready. With the compose healthcheck probing every
 *  10s, 3 consecutive failures is ~30s of sustained outage — long enough to be real, short enough to shed
 *  traffic before users notice much. Matches the workers' threshold so both services behave alike. */
export const DEFAULT_PROBE_FAILURE_THRESHOLD = 3;

/** Probe timeout. Must stay well under the healthcheck interval (10s) so a wedged database still yields a
 *  verdict within one probe cycle rather than piling up overlapping checks. */
export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/** Races `work` against a timeout, resolving false if the timeout wins or `work` rejects.
 *  The loser's rejection is swallowed deliberately: an abandoned probe query must not surface as an
 *  unhandled rejection and take the process down — the very outcome readiness exists to avoid.
 *
 *  Note what this does and does not do: it bounds how long the PROBE waits, not how long the query runs. A
 *  query abandoned here keeps running server-side until it finishes or the pool drops it. That is the right
 *  trade for a probe — cancelling would need its own connection, which is precisely what is scarce when the
 *  database is the thing in trouble.
 *
 *  Exported so the boundedness guarantee is testable without a live dependency. */
export async function boundedProbe(
  timeoutMs: number,
  work: () => Promise<unknown>,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const attempt = work().then(
      () => true,
      () => false,
    );
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Is Postgres reachable through the pool? Delegates the statement itself to `@leadwolf/db` (raw SQL belongs
 *  there, not in an app) and adds the bound this endpoint needs. */
export function dbReadinessProbe(timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS): ReadinessProbe {
  return () => boundedProbe(timeoutMs, pingDb);
}

/** The verdict. `reason` is for the operator reading a probe log, never for a client — /ready is an ops
 *  endpoint and says nothing about why beyond a coarse label. */
export type ReadinessVerdict = { ready: true } | { ready: false; reason: "draining" | "database" };

/** Builds the /ready evaluator. `isDraining` is consulted per request so drain state is always live, and it
 *  is checked FIRST: a draining process should shed traffic immediately, without waiting for a threshold or
 *  spending a probe on a database it is about to disconnect from.
 *
 *  The failure threshold applies ONLY after the process has been ready at least once. This distinction is the
 *  difference between hysteresis and a lie. Tolerating the first N failures unconditionally would mean that a
 *  process booting against a dead database answers "ready" to its first probes — and an orchestrator needs
 *  just one success to mark the container healthy and release everything gated on it (compose has web/admin
 *  waiting on `api: service_healthy`). So: before the first success, any failure is immediately not-ready;
 *  after it, the threshold absorbs blips on a replica that has proven it can serve. */
export function createReadinessGate(options: {
  isDraining: () => boolean;
  probe: ReadinessProbe;
  failureThreshold?: number;
}): () => Promise<ReadinessVerdict> {
  const threshold = options.failureThreshold ?? DEFAULT_PROBE_FAILURE_THRESHOLD;
  let consecutiveFailures = 0;
  let everReady = false;
  return async () => {
    if (options.isDraining()) return { ready: false, reason: "draining" };
    const ok = await options.probe().catch(() => false);
    if (ok) {
      consecutiveFailures = 0;
      everReady = true;
      return { ready: true };
    }
    consecutiveFailures++;
    if (!everReady || consecutiveFailures >= threshold) {
      return { ready: false, reason: "database" };
    }
    return { ready: true };
  };
}
