// fieldWaterfall.ts — the PER-FIELD provider waterfall (waterfall v2 / 0111; 06 §4 + the data-skill
// mandate: "Stop at first sufficient answer… Different fields may resolve from different providers
// (email from one, phone from another). Fall through on miss or low confidence, not on error alone.
// The ordering is configurable, not hardcoded — per-field provider preferences are data.").
//
// Shape: each requested field cascades independently down ITS resolved order (email order ≠ phone
// order), but a provider is CALLED AT MOST ONCE per request — always with the union of all
// still-unfilled fields — and its result is memoized, so differing per-field orders never pay the same
// vendor twice. Providers are skipped (never called) when: not capable of the field, disabled, circuit
// open, or gate-denied (rate/budget). A gate denial is recorded as a synthetic zero-cost `rate_limited`
// attempt so the ledger shows WHY nothing was paid.
//
// Verify-before-accept (S-08): an email candidate is verified before the field is accepted. `invalid`
// REJECTS the candidate and the cascade continues to the next provider; `catch_all` is policy
// (acceptCatchAll: accept | flag → accept with the true status persisted; continue → keep cascading,
// falling back to the FIRST catch-all if nothing better appears); `risky`/`unknown`/`unverified` are
// accepted with the verdict persisted (rejecting `unknown` would burn cascade spend on SMTP-blocked
// domains — ADR-0013 already prices those outcomes at reveal). A verifier THROW is treated as
// "didn't run" (accept, status unchanged) — a verification outage must not fail paid enrichment.
// Verification spend is folded into the ledger as `verify:email:<candidateProvider>` attempts at
// `verifyCostMicros` each (0 for a self-hosted Reacher).
//
// This module is PURE with respect to state: no env, no db, no Redis — the breaker, the gate, the
// verifiers, and the ordering all arrive as ports/inputs, so every branch is unit-testable hermetically.

import type { EmailStatus, EnrichCapability, EnrichField } from "@leadwolf/types";
import type { EmailVerifierPort } from "../data-health/emailVerifier.ts";
import type { PhoneVerifierPort } from "../data-health/phoneVerifier.ts";
import type { BreakerStore } from "./breakerStore.ts";
import type { ProviderGate, ProviderLimits } from "./providerGate.ts";
import type { EnrichRequest, EnrichmentProvider, ProviderResult } from "./providerPort.ts";

const NO_LIMITS: ProviderLimits = { rateLimitPerMin: null, monthlyBudgetCents: null };

/** The capability a provider must declare to be asked for a field (finally enforced — v1 never filtered). */
const FIELD_CAPABILITY: Record<EnrichField, EnrichCapability> = {
  email: "contact.email",
  phone: "contact.phone",
  jobTitle: "contact.profile",
  seniorityLevel: "contact.profile",
  department: "contact.profile",
};

/** Fixed pass order: contact channels first (they gate lastVerifiedAt + are the product), profile after. */
const FIELD_PASS_ORDER: readonly EnrichField[] = [
  "email",
  "phone",
  "jobTitle",
  "seniorityLevel",
  "department",
];

export interface ProviderAttempt {
  provider: string;
  status: ProviderResult["status"];
  costMicros: number;
  latencyMs: number;
  /** The fields this attempt WON (accepted after verification) — the per-field cache coverage. */
  filledFields: EnrichField[];
  retryAfterMs?: number;
  /** Verify verdicts attached to this attempt's values, keyed by field (persisted to the ledger). */
  verification?: Partial<Record<EnrichField, { status: string; verifier: string }>>;
}

export interface FieldWin {
  provider: string;
  value: string;
  confidence?: number;
  /** email only: the verify-before-accept verdict (drives contacts.email_status). */
  emailStatus?: EmailStatus;
}

export interface FieldWaterfallOutcome {
  winners: Map<EnrichField, FieldWin>;
  attempts: ProviderAttempt[];
  /** Raw payload per provider that was actually called — winners' payloads feed source_imports. */
  rawPayloadByProvider: Map<string, unknown>;
  /** True when nothing was filled AND every capable provider was throttle-denied — the deferral signal. */
  allThrottled: boolean;
  /** The smallest vendor-suggested retry delay seen this run, when one was sent. */
  retryAfterMs?: number;
}

export interface VerificationKnobs {
  verifyEmailBeforeAccept: boolean;
  acceptCatchAll: "accept" | "continue" | "flag";
  verifyPhone: boolean;
}

export interface RunFieldWaterfallsInput {
  providers: EnrichmentProvider[];
  /** The request with fields ALREADY narrowed to the uncached set. */
  request: EnrichRequest;
  /** Resolved priority per field (D8 resolution already applied) — provider NAMES, best first. */
  orderFor(field: EnrichField): string[];
  breaker: BreakerStore;
  gate: ProviderGate;
  /** provider_configs limits by provider name (missing = unlimited) — the gate's per-call input. */
  limitsByProvider?: ReadonlyMap<string, ProviderLimits>;
  /** Providers that already ANSWERED this request hash on a prior run (retry path) — never re-paid. */
  skipProviders?: ReadonlySet<string>;
  emailVerifier: EmailVerifierPort;
  phoneVerifier: PhoneVerifierPort;
  policy: VerificationKnobs;
  /** Ledger cost of one verification call (env.REACHER_COST_MICROS; 0 = self-hosted). */
  verifyCostMicros?: number;
  now?: () => number;
}

type CallOutcome =
  | { kind: "result"; result: ProviderResult }
  | { kind: "gate_denied"; retryAfterMs?: number }
  | { kind: "breaker_open" };

export async function runFieldWaterfalls(
  input: RunFieldWaterfallsInput,
): Promise<FieldWaterfallOutcome> {
  const now = input.now ?? Date.now;
  const verifyCost = input.verifyCostMicros ?? 0;
  const byName = new Map(input.providers.map((p) => [p.name, p]));
  const requested = FIELD_PASS_ORDER.filter((f) => input.request.fields.includes(f));

  const winners = new Map<EnrichField, FieldWin>();
  const attempts: ProviderAttempt[] = [];
  const rawPayloadByProvider = new Map<string, unknown>();
  /** Memo: one call per provider per request, whatever order fields walk in. */
  const callOutcomes = new Map<string, CallOutcome>();
  /** filledFields accumulate per attempt AFTER acceptance — index attempts by provider to update them. */
  const attemptByProvider = new Map<string, ProviderAttempt>();
  /** Rejected-candidate bookkeeping: catch-all fallbacks under acceptCatchAll="continue". */
  const catchAllFallback = new Map<EnrichField, FieldWin>();
  let minRetryAfterMs: number | undefined;

  async function callOnce(provider: EnrichmentProvider): Promise<CallOutcome> {
    const memo = callOutcomes.get(provider.name);
    if (memo) return memo;

    // Breaker read fails OPEN (allow) — a Redis blip must not halt enrichment.
    let open = false;
    try {
      open = await input.breaker.isOpen(provider.name);
    } catch {
      open = false;
    }
    if (open) {
      const outcome: CallOutcome = { kind: "breaker_open" };
      callOutcomes.set(provider.name, outcome);
      return outcome;
    }

    // Gate evaluation fails CLOSED (skip this provider) — the crmBudgetStore posture.
    let decision: Awaited<ReturnType<ProviderGate["allow"]>>;
    try {
      decision = await input.gate.allow(
        provider.name,
        provider.estimateCostMicros(input.request),
        input.limitsByProvider?.get(provider.name) ?? NO_LIMITS,
      );
    } catch {
      decision = { allowed: false, reason: "rate_limited" };
    }
    if (!decision.allowed) {
      if (decision.retryAfterMs !== undefined) {
        minRetryAfterMs = Math.min(
          minRetryAfterMs ?? Number.POSITIVE_INFINITY,
          decision.retryAfterMs,
        );
      }
      const attempt: ProviderAttempt = {
        provider: provider.name,
        status: "rate_limited",
        costMicros: 0,
        latencyMs: 0,
        filledFields: [],
        retryAfterMs: decision.retryAfterMs,
      };
      attempts.push(attempt);
      attemptByProvider.set(provider.name, attempt);
      const outcome: CallOutcome = { kind: "gate_denied", retryAfterMs: decision.retryAfterMs };
      callOutcomes.set(provider.name, outcome);
      return outcome;
    }

    // The paid call — ALWAYS with the union of currently-unfilled fields, so an email-pass call also
    // brings back phone/profile and later fields consume the memo without a second spend.
    const unfilled = requested.filter((f) => !winners.has(f));
    const started = now();
    let result: ProviderResult;
    try {
      result = await provider.enrich({ ...input.request, fields: unfilled });
    } catch {
      result = { fields: [], rawPayload: null, costMicros: 0, status: "error" };
    }
    const latencyMs = Math.max(0, now() - started);

    if (result.retryAfterMs !== undefined) {
      minRetryAfterMs = Math.min(minRetryAfterMs ?? Number.POSITIVE_INFINITY, result.retryAfterMs);
    }
    const attempt: ProviderAttempt = {
      provider: provider.name,
      status: result.status,
      costMicros: result.costMicros,
      latencyMs,
      filledFields: [],
      retryAfterMs: result.retryAfterMs,
    };
    attempts.push(attempt);
    attemptByProvider.set(provider.name, attempt);
    rawPayloadByProvider.set(provider.name, result.rawPayload);

    // Breaker bookkeeping: hit/miss = the provider ANSWERED; rate_limited/error count against it.
    try {
      await input.breaker.record(
        provider.name,
        result.status === "hit" || result.status === "miss",
      );
    } catch {
      // never fail a paid call on breaker bookkeeping
    }
    try {
      await input.gate.settle(provider.name, result.costMicros);
    } catch {
      // ditto for budget bookkeeping — the tx2 ledger row is the durable record
    }

    const outcome: CallOutcome = { kind: "result", result };
    callOutcomes.set(provider.name, outcome);
    return outcome;
  }

  /** Verify an email candidate; a verifier throw = "didn't run" (accept, status unchanged). */
  async function verifyEmailCandidate(
    value: string,
    candidateProvider: string,
  ): Promise<EmailStatus> {
    const started = now();
    try {
      const status = await input.emailVerifier.verify(value, "unverified");
      attempts.push({
        provider: `verify:email:${candidateProvider}`,
        status: "hit",
        costMicros: verifyCost,
        latencyMs: Math.max(0, now() - started),
        filledFields: [],
        verification: { email: { status, verifier: input.emailVerifier.name } },
      });
      return status;
    } catch {
      attempts.push({
        provider: `verify:email:${candidateProvider}`,
        status: "error",
        costMicros: 0,
        latencyMs: Math.max(0, now() - started),
        filledFields: [],
      });
      return "unverified"; // didn't run — never worse than today
    }
  }

  for (const field of requested) {
    if (winners.has(field)) continue;
    const capability = FIELD_CAPABILITY[field];

    for (const name of input.orderFor(field)) {
      const provider = byName.get(name);
      if (!provider) continue; // unknown name in stored prefs — ignore (forward-compatible)
      if (input.skipProviders?.has(name)) continue; // answered on a prior run — a retry re-buys nothing
      if (!provider.capabilities.includes(capability)) continue; // honest capability filter

      const outcome = await callOnce(provider);
      if (outcome.kind !== "result") continue;

      const candidate = outcome.result.fields.find(
        (f) => f.field === field && typeof f.value === "string" && f.value.length > 0,
      );
      if (!candidate) continue; // this provider had nothing for THIS field — cascade on

      let win: FieldWin = {
        provider: name,
        value: candidate.value,
        confidence: candidate.confidence,
      };

      if (field === "email" && input.policy.verifyEmailBeforeAccept) {
        const status = await verifyEmailCandidate(candidate.value, name);
        if (status === "invalid") continue; // fall through on failed verify — the S-08 mandate
        if (status === "catch_all" && input.policy.acceptCatchAll === "continue") {
          // Keep the FIRST catch-all as the fallback if nothing verifies clean downstream.
          if (!catchAllFallback.has(field)) {
            catchAllFallback.set(field, { ...win, emailStatus: "catch_all" });
          }
          continue;
        }
        win = { ...win, emailStatus: status };
      }

      if (field === "phone" && input.policy.verifyPhone) {
        const started = now();
        try {
          const verdict = await input.phoneVerifier.verify(candidate.value, null);
          attempts.push({
            provider: `verify:phone:${name}`,
            status: "hit",
            costMicros: verifyCost,
            latencyMs: Math.max(0, now() - started),
            filledFields: [],
            verification: {
              phone: { status: verdict.status, verifier: input.phoneVerifier.name },
            },
          });
          if (verdict.status === "invalid") continue; // carrier-confirmed dead number — cascade on
        } catch {
          // verifier outage = didn't run; accept the candidate
        }
      }

      winners.set(field, win);
      const attempt = attemptByProvider.get(name);
      if (attempt) attempt.filledFields.push(field);
      break; // stop at first sufficient answer — per FIELD, not per request
    }

    // Cascade exhausted with only a catch-all in hand → take it rather than return nothing.
    if (!winners.has(field)) {
      const fallback = catchAllFallback.get(field);
      if (fallback) {
        winners.set(field, fallback);
        const attempt = attemptByProvider.get(fallback.provider);
        if (attempt) attempt.filledFields.push(field);
      }
    }
  }

  const anyAnswered = attempts.some((a) => a.status === "hit" || a.status === "miss");
  const anyThrottled = attempts.some((a) => a.status === "rate_limited");
  const allThrottled = winners.size === 0 && anyThrottled && !anyAnswered;

  return {
    winners,
    attempts,
    rawPayloadByProvider,
    allThrottled,
    retryAfterMs: Number.isFinite(minRetryAfterMs ?? Number.NaN) ? minRetryAfterMs : undefined,
  };
}
