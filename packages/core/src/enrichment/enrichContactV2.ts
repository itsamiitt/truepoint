// enrichContactV2.ts — the waterfall-v2 orchestration (0109): the tx-split successor to enrichContact's
// single-transaction body, entered ONLY through enrichContact's dual gate (WATERFALL_V2_ENABLED env +
// the enrichment_waterfall_v2 tenant flag). [S-04][S-08][A-01]
//
// THE TX SPLIT (the wart enrichContact.ts:143 documents, fixed):
//   tx1 (reads)  — contact + per-field cache + daily-budget PRE-check (throws ONLY here, before any
//                  spend) + provider_configs. No lock is held past commit.
//   no tx        — provider calls + verification (all network I/O outside any transaction).
//   tx2 (writes) — lockDailyBudget (advisory xact lock) → record EVERY attempt (money was spent; the
//                  ledger must reflect reality — tx2 NEVER throws a budget error after spend, or a BullMQ
//                  retry double-buys) → overlay upsert + per-provider provenance fold → one source_imports
//                  row per WINNING provider → channel dual-write.
//   after tx2    — Layer-0 evidence + provenance events in their OWN withErTx (enrichmentEvidence.ts).
//
// Replay-safety: a retry after tx2 finds the per-field cache rows and short-circuits at zero cost; a
// crash between the provider I/O and tx2 re-buys at most once per retry attempt — the same exposure the
// v1 path had (a mid-tx crash never un-called the vendor). Concurrent same-workspace runs briefly
// overshoot the daily budget by their in-flight cost at most — bounded by the queue's concurrency,
// serialized at record time by the advisory lock.

import { env } from "@leadwolf/config";
import {
  type ContactWriteValues,
  type TenantScope,
  contactChannelRepository,
  contactRepository,
  enrichmentPolicyRepository,
  providerCallRepository,
  providerConfigRepository,
  revealRepository,
  withTenantTx,
} from "@leadwolf/db";
import { blindIndex } from "@leadwolf/identity";
import {
  CONTACT_PROVENANCE_FIELDS,
  DEFAULT_PROVIDER_PRIORITY,
  DEFAULT_VERIFICATION_POLICY,
  ENRICHMENT_WATERFALL_V2_FLAG_KEY,
  type EnrichField,
  NotFoundError,
  ProviderBudgetExceededError,
  type ProviderPriority,
  type VerificationPolicy,
} from "@leadwolf/types";
import { buildPhoneChannelValue, isChannelDualWriteEnabled } from "../channels/channelDualWrite.ts";
import type { EmailVerifierPort } from "../data-health/emailVerifier.ts";
import type { PhoneVerifierPort } from "../data-health/phoneVerifier.ts";
import { isFlagEnabledForTenant } from "../feature-flags/flagsForTenant.ts";
import { decryptPii, encryptPii } from "../import/encryptPii.ts";
import { planFieldWrite } from "../prospect/fieldProvenance.ts";
import type { BreakerStore } from "./breakerStore.ts";
import { recordEnrichmentEvidence } from "./enrichmentEvidence.ts";
import { type FieldWin, runFieldWaterfalls } from "./fieldWaterfall.ts";
import type { ProviderGate, ProviderLimits } from "./providerGate.ts";
import type { EnrichRequest, EnrichmentProvider } from "./providerPort.ts";
import { requestHash } from "./requestHash.ts";
import { appendSourceImports } from "./sourceImports.ts";
import { orderProviders } from "./waterfall.ts";

export interface EnrichV2Deps {
  breaker: BreakerStore;
  gate: ProviderGate;
  emailVerifier: EmailVerifierPort;
  phoneVerifier: PhoneVerifierPort;
}

export interface EnrichmentV2Run {
  scope: TenantScope & { workspaceId: string };
  contactId: string;
  /** Post-policy-narrowed requested fields. */
  fields: EnrichField[];
  providers: EnrichmentProvider[];
  requestedByUserId?: string | null;
  /** Per-RUN ordering override (validated at the API edge against the known set; never persisted). */
  providerOrder?: string[];
  deps: EnrichV2Deps;
}

export interface EnrichmentV2Result {
  status: "cache_hit" | "enriched" | "unfilled";
  provider: string | null;
  filled: EnrichField[];
  costMicros: number;
  /** Which provider won each filled field (email from A, phone from B). */
  filledBy?: Partial<Record<EnrichField, string>>;
  /** The verify-before-accept verdict persisted for a won email. */
  emailStatus?: string;
  /** Every capable provider was throttle-denied and nothing was filled — the worker defers (re-enqueues). */
  allThrottled?: boolean;
  retryAfterMs?: number;
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The v2 dual gate (D10), evaluated per run in its own scoped tx: the WATERFALL_V2_ENABLED env layer is
 * checked by the CALLER with zero queries; this is the per-tenant canary half (fail-closed — unknown flag
 * or a read error ⇒ legacy path). The channelDualWriteEnabledForScope posture exactly.
 */
export async function waterfallV2EnabledForScope(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<boolean> {
  try {
    return await withTenantTx(scope, (tx) =>
      isFlagEnabledForTenant(tx, scope.tenantId, ENRICHMENT_WATERFALL_V2_FLAG_KEY),
    );
  } catch (err) {
    console.error("[enrichment] waterfall v2 flag read failed; using legacy path", err);
    return false;
  }
}

/**
 * D8 ordering resolution, PURE: per-run override → workspace per-field priority → the engine default
 * (trust ÷ cost). An explicit list is a PREFIX — providers it omits still cascade after it in default
 * order (a partial preference must not silently disable the rest of the pool). `disabled` (workspace)
 * and config-disabled providers are subtracted last; unknown names are ignored (forward-compatible).
 */
export function resolveProviderOrder(opts: {
  providers: EnrichmentProvider[];
  request: EnrichRequest;
  field: EnrichField;
  runOverride?: string[];
  priority: ProviderPriority;
  configDisabled: ReadonlySet<string>;
}): string[] {
  const defaultOrder = orderProviders(opts.providers, opts.request).map((p) => p.name);
  const pref =
    opts.field === "email"
      ? opts.priority.email
      : opts.field === "phone"
        ? opts.priority.phone
        : [];
  const known = new Set(opts.providers.map((p) => p.name));
  const explicitRaw = opts.runOverride?.length ? opts.runOverride : pref.length ? pref : null;
  const explicit = explicitRaw?.filter((n) => known.has(n)) ?? null;
  const base = explicit?.length
    ? [...explicit, ...defaultOrder.filter((n) => !explicit.includes(n))]
    : defaultOrder;
  const disabled = new Set<string>([...opts.priority.disabled, ...opts.configDisabled]);
  return base.filter((n) => !disabled.has(n));
}

/** Map the per-field winners onto the overlay write shape (PII encrypted before it touches the db layer). */
function toWriteValues(winners: ReadonlyMap<EnrichField, FieldWin>): Partial<ContactWriteValues> {
  const values: Partial<ContactWriteValues> = {};
  for (const [field, win] of winners) {
    if (field === "email") {
      const normalized = win.value.trim().toLowerCase();
      values.emailEnc = encryptPii(normalized);
      values.emailBlindIndex = blindIndex(normalized);
      values.emailDomain = normalized.split("@")[1] ?? null;
      // A NEW email value must carry ITS verification state — leaving the previous address's status in
      // place would let a stale "valid" describe an address we never verified.
      values.emailStatus = win.emailStatus ?? "unverified";
    } else if (field === "phone") {
      values.phoneEnc = encryptPii(win.value.trim());
    } else if (field === "jobTitle") {
      values.jobTitle = win.value;
    } else if (field === "seniorityLevel") {
      values.seniorityLevel = win.value;
    } else if (field === "department") {
      values.department = win.value;
    }
  }
  return values;
}

export async function runEnrichmentV2(run: EnrichmentV2Run): Promise<EnrichmentV2Result> {
  const { scope, deps } = run;

  // The workspace policy (priority + verification knobs + lawful basis). Own short tx — the values are
  // configuration, not row state; a policy PATCH racing this read simply applies from the next run.
  const policyRow = await enrichmentPolicyRepository.get(scope);
  const priority: ProviderPriority = policyRow?.providerPriority ?? DEFAULT_PROVIDER_PRIORITY;
  const verification: VerificationPolicy = policyRow?.verification ?? DEFAULT_VERIFICATION_POLICY;

  // ── tx1: reads only ────────────────────────────────────────────────────────────────────────────────
  const pre = await withTenantTx(scope, async (tx) => {
    const contact = await revealRepository.getContactForReveal(tx, run.contactId);
    if (!contact) throw new NotFoundError("Contact not found in this workspace.");

    const request: EnrichRequest = {
      workspaceId: scope.workspaceId,
      entityType: "contact",
      fields: run.fields,
      subject: {
        email: contact.emailEnc ? decryptPii(contact.emailEnc) : undefined,
        companyDomain: contact.emailDomain ?? undefined,
      },
    };
    const hash = requestHash(request);

    const cached = await providerCallRepository.findCachedFields(tx, scope.workspaceId, hash);
    const uncovered =
      cached.coveredFields === "all"
        ? []
        : run.fields.filter((f) => !(cached.coveredFields as EnrichField[]).includes(f));

    // Budget PRE-check: the only place v2 throws on budget, and no spend has happened yet. (No advisory
    // lock here — an xact lock cannot outlive tx1; tx2 takes it around the recording.)
    if (uncovered.length > 0) {
      const spent = await providerCallRepository.spendSince(tx, scope.workspaceId, startOfUtcDay());
      if (spent >= env.ENRICH_DAILY_BUDGET_MICROS) {
        throw new ProviderBudgetExceededError(
          `Daily enrichment budget reached (${spent}µ$ of ${env.ENRICH_DAILY_BUDGET_MICROS}µ$).`,
        );
      }
    }

    const configs = await providerConfigRepository.list(tx);
    return { contact, request, hash, uncovered, cachedProviders: cached.byProvider, configs };
  });

  if (pre.uncovered.length === 0) {
    return {
      status: "cache_hit",
      provider: pre.cachedProviders[0]?.providerName ?? null,
      filled: [],
      costMicros: 0,
    };
  }

  const configDisabled = new Set(pre.configs.filter((c) => !c.enabled).map((c) => c.provider));
  const limitsByProvider = new Map<string, ProviderLimits>(
    pre.configs.map((c) => [
      c.provider,
      { rateLimitPerMin: c.rateLimitPerMin, monthlyBudgetCents: c.monthlyBudgetCents },
    ]),
  );

  const request: EnrichRequest = { ...pre.request, fields: pre.uncovered };

  // ── no tx: the per-field waterfall + verification ──────────────────────────────────────────────────
  const outcome = await runFieldWaterfalls({
    providers: run.providers,
    request,
    orderFor: (field) =>
      resolveProviderOrder({
        providers: run.providers,
        request,
        field,
        runOverride: run.providerOrder,
        priority,
        configDisabled,
      }),
    breaker: deps.breaker,
    gate: deps.gate,
    limitsByProvider,
    emailVerifier: deps.emailVerifier,
    phoneVerifier: deps.phoneVerifier,
    policy: verification,
    verifyCostMicros: env.REACHER_COST_MICROS,
  });

  const costMicros = outcome.attempts.reduce((sum, a) => sum + a.costMicros, 0);

  // ── tx2: writes only; never throws a budget error after money moved ────────────────────────────────
  const persisted = await withTenantTx(scope, async (tx) => {
    await providerCallRepository.lockDailyBudget(tx, scope.workspaceId);

    for (const attempt of outcome.attempts) {
      await providerCallRepository.record(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        providerName: attempt.provider,
        requestHash: pre.hash,
        status: attempt.status,
        costMicros: attempt.costMicros,
        latencyMs: attempt.latencyMs,
        // v2 rows ALWAYS carry filledFields (possibly []) — null is the legacy "covered everything"
        // sentinel and must never appear on a per-field row.
        filledFields: attempt.filledFields,
        verification: attempt.verification,
        responsePayload:
          attempt.status === "hit" ? outcome.rawPayloadByProvider.get(attempt.provider) : undefined,
      });
    }

    if (outcome.winners.size === 0) return { sourceImportIdByProvider: new Map<string, string>() };

    const verifiedPii = outcome.winners.has("email") || outcome.winners.has("phone");

    // Field-provenance pin fold, CHAINED per winning provider so each scalar's descriptor names the
    // provider that actually supplied it (src: provider:<name>) — v1 stamped one provider for the whole
    // request because one provider WAS the whole request.
    const byProvider = new Map<string, EnrichField[]>();
    for (const [field, win] of outcome.winners) {
      const list = byProvider.get(win.provider) ?? [];
      list.push(field);
      byProvider.set(win.provider, list);
    }

    let provenance = await contactRepository.getFieldProvenance(tx, run.contactId);
    const writableScalars = new Set<string>();
    const nowIso = new Date().toISOString();
    for (const [providerName, wonFields] of byProvider) {
      const scalars = wonFields.filter((f) =>
        (CONTACT_PROVENANCE_FIELDS as readonly string[]).includes(f),
      );
      if (scalars.length === 0) continue;
      const plan = planFieldWrite(provenance, scalars, {
        src: `provider:${providerName}`,
        ver: nowIso,
      });
      provenance = plan.provenance;
      for (const f of plan.writableFields) writableScalars.add(f);
    }

    const writeValues = toWriteValues(outcome.winners);
    for (const [field] of outcome.winners) {
      const isScalar = (CONTACT_PROVENANCE_FIELDS as readonly string[]).includes(field);
      if (isScalar && !writableScalars.has(field)) {
        delete (writeValues as Record<string, unknown>)[field]; // pinned — the user's value stands
      }
    }

    await contactRepository.update(tx, run.contactId, {
      ...writeValues,
      fieldProvenance: provenance,
      ...(verifiedPii ? { lastVerifiedAt: new Date() } : {}),
    });

    // One source_imports row per WINNING provider — each winner's raw payload under its own name.
    const sourceImportIdByProvider = await appendSourceImports(tx, {
      scope,
      contactId: run.contactId,
      requestedByUserId: run.requestedByUserId ?? null,
      providers: [...byProvider.keys()],
      rawPayloadByProvider: outcome.rawPayloadByProvider,
    });

    // S-CH2 channel dual-write — per winner, under ITS provider's source label + source_imports row.
    if (await isChannelDualWriteEnabled(tx, scope.tenantId)) {
      const emailWin = outcome.winners.get("email");
      if (
        emailWin &&
        writeValues.emailEnc &&
        writeValues.emailBlindIndex &&
        writeValues.emailDomain
      ) {
        await contactChannelRepository.applyChannelWrite(tx, scope, {
          kind: "email_upsert",
          contactId: run.contactId,
          value: {
            valueEnc: writeValues.emailEnc,
            blindIndex: writeValues.emailBlindIndex,
            emailDomain: writeValues.emailDomain,
            type: "work",
            source: `provider:${emailWin.provider}`,
            sourceImportId: sourceImportIdByProvider.get(emailWin.provider) ?? null,
          },
        });
      }
      const phoneWin = outcome.winners.get("phone");
      if (phoneWin && writeValues.phoneEnc) {
        const built = buildPhoneChannelValue({
          cleaned: phoneWin.value.trim(),
          phoneEnc: writeValues.phoneEnc,
        });
        await contactChannelRepository.applyChannelWrite(tx, scope, {
          kind: "phone_upsert",
          contactId: run.contactId,
          value: {
            ...built,
            type: "work",
            source: `provider:${phoneWin.provider}`,
            sourceImportId: sourceImportIdByProvider.get(phoneWin.provider) ?? null,
          },
        });
      }
    }

    return { sourceImportIdByProvider };
  });

  if (outcome.winners.size === 0) {
    return {
      status: "unfilled",
      provider: null,
      filled: [],
      costMicros,
      allThrottled: outcome.allThrottled,
      retryAfterMs: outcome.retryAfterMs,
    };
  }

  // ── after tx2: Layer-0 evidence + provenance events, own withErTx (D9; import D7 posture) ──────────
  if (env.INGESTION_EVIDENCE_ENABLED && pre.contact.masterPersonId) {
    await recordEnrichmentEvidence({
      masterPersonId: pre.contact.masterPersonId,
      winners: outcome.winners,
      rawPayloadByProvider: outcome.rawPayloadByProvider,
      emailDomain: pre.contact.emailDomain ?? undefined,
      workspaceLawfulBasis: policyRow?.lawfulBasis ?? null,
    });
  }
  void persisted;

  const filledBy: Partial<Record<EnrichField, string>> = {};
  for (const [field, win] of outcome.winners) filledBy[field] = win.provider;
  // Headline provider = the one that won the most fields (tie → attempt order, i.e. cascade position).
  let top: string | null = null;
  let topCount = 0;
  const counts = new Map<string, number>();
  for (const [, win] of outcome.winners) {
    const n = (counts.get(win.provider) ?? 0) + 1;
    counts.set(win.provider, n);
    if (n > topCount) {
      top = win.provider;
      topCount = n;
    }
  }

  return {
    status: "enriched",
    provider: top,
    filled: [...outcome.winners.keys()],
    costMicros,
    filledBy,
    emailStatus: outcome.winners.get("email")?.emailStatus,
  };
}
