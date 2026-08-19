// idempotency.ts — replay the stored first response for a seen (tenant, Idempotency-Key) on money
// endpoints (07 §3, 09 §5), now CLAIM-then-execute (perf-audit P2.5). The old find→execute→store shape only
// replayed COMPLETED requests: two concurrent duplicates — a double-click, a proxy retry racing the original
// — both missed the find and both ran the handler, so the middleware bought latency without buying the
// guarantee. The claim stakes the key atomically BEFORE the handler:
//
//   claimed   → run the handler; finalize the response (success) or release the claim (failure — failures
//               are never replayed, a retry must re-execute; exactly the old semantics).
//   replay    → answer the stored first response, marked `idempotency-replayed`.
//   in_flight → 409 `request_in_flight` with a retry hint: the twin is still executing, and its result will
//               replay once it lands. A claimant that DIED mid-execution (crash between claim and
//               finalize/release) is taken over after TAKEOVER_AFTER_MS, so a stuck key can never brick
//               retries; the DB uniques on the money tables remain the real double-charge guard underneath.

import { idempotencyRepository } from "@leadwolf/db";
import { AppError } from "@leadwolf/types";
import type { Context, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { TenancyVariables } from "./tenancy.ts";

/** Comfortably above any legitimate money-handler runtime (the reveal verifier is bounded at 5s); past it a
 *  still-sentinel claim means the claimant crashed, and a retry may take the key over and re-execute. */
const TAKEOVER_AFTER_MS = 60_000;

export async function idempotency(
  c: Context<{ Variables: TenancyVariables }>,
  next: Next,
): Promise<Response | undefined> {
  const key = c.req.header("idempotency-key");
  if (!key) {
    await next();
    return undefined;
  }

  const scope = { tenantId: c.get("tenantId"), workspaceId: c.get("workspaceId") };
  const claim = await idempotencyRepository.claim(scope, key, TAKEOVER_AFTER_MS);

  if (claim.outcome === "replay") {
    c.header("idempotency-replayed", "true");
    return c.json(
      claim.stored.responseBody as Record<string, unknown>,
      claim.stored.responseStatus as ContentfulStatusCode,
    );
  }
  if (claim.outcome === "in_flight") {
    throw new AppError({
      status: 409,
      code: "request_in_flight",
      title: "Request already in progress",
      detail:
        "An identical request with this Idempotency-Key is still being processed. Retry shortly to receive its result.",
      extensions: { retryAfterSeconds: 2 },
    });
  }

  // claimed — run the handler, then settle the claim. A thrown handler error releases before propagating.
  try {
    await next();
  } catch (e) {
    await idempotencyRepository.release(scope, key).catch(() => {
      // Best-effort: an unreleased sentinel is healed by the stale takeover after TAKEOVER_AFTER_MS.
    });
    throw e;
  }

  const res = c.res;
  if (res && res.status < 400) {
    try {
      const body = (await res.clone().json()) as unknown;
      await idempotencyRepository.finalize(scope, key, {
        responseStatus: res.status,
        responseBody: body,
      });
    } catch {
      // Non-JSON or unreadable body — release so a retry re-executes; the endpoint stays idempotent via
      // its DB constraints (the pre-claim behavior for unstorable responses).
      await idempotencyRepository.release(scope, key).catch(() => {});
    }
  } else {
    await idempotencyRepository.release(scope, key).catch(() => {});
  }
  return undefined;
}
