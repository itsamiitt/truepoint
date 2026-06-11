// enrichContact.ts — the enrichment orchestration (06 §4): cache check (provider_calls.request_hash) →
// budget breaker → provider waterfall → persist (overlay upsert + source_imports provenance +
// provider_calls cost row), all inside one withTenantTx. Enrichment is a SYSTEM cost — users pay only on
// reveal (06 §1). Providers are INJECTED (the port lives here; adapters live in packages/integrations).

import { env } from "@leadwolf/config";
import {
  type ContactWriteValues,
  type TenantScope,
  contactRepository,
  providerCallRepository,
  revealRepository,
  sourceImportRepository,
  withTenantTx,
} from "@leadwolf/db";
import {
  type EnrichField,
  NotFoundError,
  ProviderBudgetExceededError,
  sourceName as sourceNameEnum,
} from "@leadwolf/types";
import { blindIndex } from "../import/blindIndex.ts";
import { decryptPii, encryptPii } from "../import/encryptPii.ts";
import type { EnrichRequest, EnrichmentProvider, ProviderFieldResult } from "./providerPort.ts";
import { requestHash } from "./requestHash.ts";
import { runWaterfall } from "./waterfall.ts";

export interface EnrichContactInput {
  scope: TenantScope & { workspaceId: string };
  contactId: string;
  fields: EnrichField[];
  providers: EnrichmentProvider[];
  requestedByUserId?: string | null;
}

export interface EnrichContactResult {
  status: "cache_hit" | "enriched" | "unfilled";
  provider: string | null;
  filled: EnrichField[];
  costMicros: number;
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
  return withTenantTx(input.scope, async (tx) => {
    const contact = await revealRepository.getContactForReveal(tx, input.contactId);
    if (!contact) throw new NotFoundError("Contact not found in this workspace.");

    const request: EnrichRequest = {
      workspaceId: input.scope.workspaceId,
      entityType: "contact",
      fields: input.fields,
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

    // 2) Daily budget breaker (06 §6) — checked before any paid call.
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

    // 5) Overlay upsert + per-import provenance (06 §4 — the same shape the import pipeline writes).
    await contactRepository.update(tx, input.contactId, toWriteValues(outcome.result.fields));
    const provenanceSource = sourceNameEnum.safeParse(outcome.provider);
    if (provenanceSource.success) {
      await sourceImportRepository.append(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        contactId: input.contactId,
        importedByUserId: input.requestedByUserId ?? null,
        sourceName: provenanceSource.data,
        rawData: (outcome.result.rawPayload ?? {}) as Record<string, unknown>,
      });
    }

    return {
      status: "enriched",
      provider: outcome.provider,
      filled: outcome.result.fields.map((f) => f.field),
      costMicros,
    };
  });
}
