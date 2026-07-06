// enrichContact.ts — the enrichment orchestration (06 §4): cache check (provider_calls.request_hash) →
// budget breaker → provider waterfall → persist (overlay upsert + source_imports provenance +
// provider_calls cost row), all inside one withTenantTx. Enrichment is a SYSTEM cost — users pay only on
// reveal (06 §1). Providers are INJECTED (the port lives here; adapters live in packages/integrations).

import { env } from "@leadwolf/config";
import {
  type ContactWriteValues,
  type TenantScope,
  contactChannelRepository,
  contactRepository,
  providerCallRepository,
  revealRepository,
  sourceImportRepository,
  withTenantTx,
} from "@leadwolf/db";
import {
  CONTACT_PROVENANCE_FIELDS,
  type EnrichField,
  type EnrichTrigger,
  NotFoundError,
  ProviderBudgetExceededError,
  sourceName as sourceNameEnum,
} from "@leadwolf/types";
import { buildPhoneChannelValue, isChannelDualWriteEnabled } from "../channels/channelDualWrite.ts";
import { blindIndex } from "../import/blindIndex.ts";
import { decryptPii, encryptPii } from "../import/encryptPii.ts";
import { planFieldWrite } from "../prospect/fieldProvenance.ts";
import { type AutoEnrichDenyReason, enforceAutoEnrichPolicy } from "./policy.ts";
import type { EnrichRequest, EnrichmentProvider, ProviderFieldResult } from "./providerPort.ts";
import { requestHash } from "./requestHash.ts";
import { runWaterfall } from "./waterfall.ts";

export interface EnrichContactInput {
  scope: TenantScope & { workspaceId: string };
  contactId: string;
  fields: EnrichField[];
  providers: EnrichmentProvider[];
  requestedByUserId?: string | null;
  /**
   * When set, this is a SYSTEM-initiated auto-enrich and the per-workspace auto-enrich policy (G-ENR-1) is
   * enforced FIRST: the trigger must be enabled, the requested fields are narrowed to the allowlist, and the
   * run is skipped once the monthly budget cap is reached. Omit it for a manual/user-initiated enrich (the
   * default), which bypasses the policy exactly as before — this keeps the change additive.
   */
  trigger?: EnrichTrigger;
}

export interface EnrichContactResult {
  status: "cache_hit" | "enriched" | "unfilled" | "policy_skipped";
  provider: string | null;
  filled: EnrichField[];
  costMicros: number;
  /** Set only when `status` is `policy_skipped` — why the auto-enrich policy denied the run (G-ENR-1). */
  policyReason?: AutoEnrichDenyReason;
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Map provider field results onto the overlay write shape (PII encrypted before it touches the db layer). */
function toWriteValues(fields: ProviderFieldResult[]): Partial<ContactWriteValues> {
  const values: Partial<ContactWriteValues> = {};
  for (const f of fields) {
    if (f.field === "email") {
      const normalized = f.value.trim().toLowerCase();
      values.emailEnc = encryptPii(normalized);
      values.emailBlindIndex = blindIndex(normalized);
      values.emailDomain = normalized.split("@")[1] ?? null;
    } else if (f.field === "phone") {
      values.phoneEnc = encryptPii(f.value.trim());
    } else if (f.field === "jobTitle") {
      values.jobTitle = f.value;
    } else if (f.field === "seniorityLevel") {
      values.seniorityLevel = f.value;
    } else if (f.field === "department") {
      values.department = f.value;
    }
  }
  return values;
}

export async function enrichContact(input: EnrichContactInput): Promise<EnrichContactResult> {
  // 0) Auto-enrich policy gate (G-ENR-1) — ONLY for system-initiated runs (a `trigger` is set). The guard
  //    runs BEFORE the work transaction: it denies a disabled policy / non-enabled trigger, narrows the
  //    requested fields to the allowlist, and stops at the monthly budget cap. A manual enrich (no trigger)
  //    skips this entirely, leaving the existing reveal-initiated path untouched.
  let fields = input.fields;
  if (input.trigger) {
    const decision = await enforceAutoEnrichPolicy(input.scope, {
      trigger: input.trigger,
      requestedFields: input.fields,
    });
    if (!decision.allowed) {
      return {
        status: "policy_skipped",
        provider: null,
        filled: [],
        costMicros: 0,
        policyReason: decision.reason ?? undefined,
      };
    }
    fields = decision.allowedFields; // only the allowlisted fields reach the waterfall
  }

  return withTenantTx(input.scope, async (tx) => {
    const contact = await revealRepository.getContactForReveal(tx, input.contactId);
    if (!contact) throw new NotFoundError("Contact not found in this workspace.");

    const request: EnrichRequest = {
      workspaceId: input.scope.workspaceId,
      entityType: "contact",
      fields,
      subject: {
        email: contact.emailEnc ? decryptPii(contact.emailEnc) : undefined,
        companyDomain: contact.emailDomain ?? undefined,
      },
    };
    const hash = requestHash(request);

    // 1) Cache-first (06 §5): a persisted hit answers with no call and no cost.
    const cached = await providerCallRepository.findCached(tx, input.scope.workspaceId, hash);
    if (cached)
      return { status: "cache_hit", provider: cached.providerName, filled: [], costMicros: 0 };

    // 2) Daily budget breaker (06 §6) — checked before any paid call. ATOMIC (re-audit F3): the advisory
    // xact lock serializes the check-through-record window per workspace, so concurrent enrichments can no
    // longer all read a stale under-budget total and collectively overshoot the daily cap. The lock rides
    // this tx (released at commit/rollback); cross-workspace concurrency is unaffected.
    await providerCallRepository.lockDailyBudget(tx, input.scope.workspaceId);
    const spent = await providerCallRepository.spendSince(
      tx,
      input.scope.workspaceId,
      startOfUtcDay(),
    );
    if (spent >= env.ENRICH_DAILY_BUDGET_MICROS) {
      throw new ProviderBudgetExceededError(
        `Daily enrichment budget reached (${spent}µ$ of ${env.ENRICH_DAILY_BUDGET_MICROS}µ$).`,
      );
    }

    // 3) The waterfall (06 §4) — NOTE: provider calls are network I/O inside this tx; enrichment runs on
    // workers (not the reveal lock path) so the held transaction is acceptable at M4 volume.
    const outcome = await runWaterfall(input.providers, request);
    const costMicros = outcome.attempts.reduce((sum, a) => sum + a.costMicros, 0);

    // 4) Persist every attempt's cost; the winning payload becomes the cache entry.
    for (const attempt of outcome.attempts) {
      await providerCallRepository.record(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        providerName: attempt.provider,
        requestHash: hash,
        status: attempt.status,
        costMicros: attempt.costMicros,
        responsePayload:
          attempt.provider === outcome.provider ? outcome.result?.rawPayload : undefined,
      });
    }

    if (!outcome.provider || !outcome.result) {
      return { status: "unfilled", provider: null, filled: [], costMicros };
    }

    // 5) Overlay upsert + per-import provenance (06 §4 — the same shape the import pipeline writes). Stamp
    //    `last_verified_at` ONLY when the verifiable PII (email/phone) was actually (re)sourced — those are the
    //    fields whose freshness the Data Health column tracks (list-plan/06 §3.3). A jobTitle/company-only fill
    //    must NOT reset the email freshness clock, or a contact with a 200-day-old email would falsely read
    //    "fresh". `verifiedPii` is true exactly when the winning payload filled email or phone.
    const verifiedPii = outcome.result.fields.some(
      (f) => f.field === "email" || f.field === "phone",
    );

    // Field-provenance pin (PLAN_03 §1.4/§3.1) — SCALAR fields only. A user-pinned scalar (jobTitle/
    // seniorityLevel/department) must NOT be overwritten by the provider. We read the existing provenance,
    // plan the write against the provider's scalar fields, then drop any scalar key the plan refused (pinned)
    // from the overlay write — leaving the user's value AND its descriptor untouched. email/phone are NOT
    // pin-gated in this slice (their encrypted columns are always written, as before).
    const existing = await contactRepository.getFieldProvenance(tx, input.contactId);
    const scalarFieldNames = outcome.result.fields
      .filter((f) => (CONTACT_PROVENANCE_FIELDS as readonly string[]).includes(f.field))
      .map((f) => f.field);
    const { writableFields, provenance } = planFieldWrite(existing, scalarFieldNames, {
      src: `provider:${outcome.provider}`,
      ver: new Date().toISOString(),
    });

    const writeValues = toWriteValues(outcome.result.fields);
    // Drop any pinned scalar key from the write (the provider value must not overwrite the user's).
    for (const f of scalarFieldNames) {
      if (!writableFields.has(f)) {
        delete (writeValues as Record<string, unknown>)[f];
      }
    }

    await contactRepository.update(tx, input.contactId, {
      ...writeValues,
      fieldProvenance: provenance,
      ...(verifiedPii ? { lastVerifiedAt: new Date() } : {}),
    });
    const provenanceSource = sourceNameEnum.safeParse(outcome.provider);
    let sourceImportId: string | null = null;
    if (provenanceSource.success) {
      sourceImportId = await sourceImportRepository.append(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        contactId: input.contactId,
        importedByUserId: input.requestedByUserId ?? null,
        sourceName: provenanceSource.data,
        rawData: (outcome.result.rawPayload ?? {}) as Record<string, unknown>,
      });
    }

    // S-CH2 channel dual-write (05 §5 — "enrichment writers migrate onto applyChannelWrite during S-CH2"):
    // gate-on, the provider's email/phone fills ALSO land as child rows in THIS SAME tx — the exact bytes
    // just written flat (byte-identical projection, CH-INV-1), row-level provenance `provider:<name>`.
    // Existing primaries are never flipped (05 §3.3): a second verified channel appends as a secondary —
    // the paid data that used to be discarded (02 §RC-4). Gate-off: zero flag reads, zero child writes.
    if (await isChannelDualWriteEnabled(tx, input.scope.tenantId)) {
      const source = `provider:${outcome.provider}`;
      for (const f of outcome.result.fields) {
        if (f.field === "email" && writeValues.emailEnc && writeValues.emailBlindIndex) {
          if (!writeValues.emailDomain) continue; // degenerate provider value — no well-formed domain facet
          await contactChannelRepository.applyChannelWrite(tx, input.scope, {
            kind: "email_upsert",
            contactId: input.contactId,
            value: {
              valueEnc: writeValues.emailEnc,
              blindIndex: writeValues.emailBlindIndex,
              emailDomain: writeValues.emailDomain,
              type: "work",
              source,
              sourceImportId,
            },
          });
        } else if (f.field === "phone" && writeValues.phoneEnc) {
          const built = buildPhoneChannelValue({
            cleaned: f.value.trim(),
            phoneEnc: writeValues.phoneEnc,
          });
          await contactChannelRepository.applyChannelWrite(tx, input.scope, {
            kind: "phone_upsert",
            contactId: input.contactId,
            value: { ...built, type: "work", source, sourceImportId },
          });
        }
      }
    }

    return {
      status: "enriched",
      provider: outcome.provider,
      filled: outcome.result.fields.map((f) => f.field),
      costMicros,
    };
  });
}
