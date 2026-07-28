// crmRunnerDeps.ts — the composition root's adapter between the PURE CRM runners and the real repositories
// (crm-sync 00 §3.1). apps/workers is the only layer allowed to know about both, so this file is where the
// injected `deps` objects the runners declare get their bodies.
//
// Everything here runs INSIDE a withTenantTx the caller opened, so every read and write is RLS-scoped to the
// job's tenant/workspace. The one exception is `resolveGates`, which reads the per-tenant feature flag and
// therefore also runs tenant-scoped — the flag lookup must not be able to see another tenant's flags.
//
// TWO THINGS THIS FILE IS CAREFUL ABOUT:
//
//  1. THE TOKEN IS DECRYPTED AS LATE AS POSSIBLE. loadTokenBundle is a function the runner calls only once
//     its gate ladder has decided a real CRM call will happen; it is not resolved eagerly when the deps are
//     built. Building the deps must never itself decrypt a credential.
//  2. SUPPRESSION IS COMPUTED FROM THE BLIND INDEX, NOT FROM CLEARTEXT. The suppression store matches on an
//     HMAC of the email, so the check works without ever holding the address in memory longer than the hash
//     takes to compute.

import { env } from "@leadwolf/config";
import {
  type CrmInboundDeps,
  type CrmPullDeps,
  type CrmPushDeps,
  type CrmTokenBundle,
  blindIndex,
  decryptCrmTokenBundle,
  encryptPii,
  isFlagEnabledForTenant,
} from "@leadwolf/core";
import {
  type Tx,
  contactRepository,
  crmConnectionRepository,
  crmFieldMappingRepository,
  crmRecordLinkRepository,
  crmSyncConflictRepository,
  crmSyncRunRepository,
  crmSyncStateRepository,
  suppressionRepository,
} from "@leadwolf/db";
import { CRM_SYNC_FLAG_KEY, type CrmFieldMapping } from "@leadwolf/types";

export interface CrmJobContext {
  tenantId: string;
  workspaceId: string;
  connectionId: string;
  runId: string;
}

/**
 * Resolve the three gates for a job.
 *
 * All three are read AT JOB TIME rather than trusted from the payload: a job can sit in Redis across a flag
 * flip or a connection being paused, and the operator who turned something off expects the next job to
 * stop. The tenant flag is fail-closed by `isFlagEnabledForTenant` (unknown tenant ⇒ off).
 */
export async function resolveGates(
  tx: Tx,
  ctx: CrmJobContext,
): Promise<{
  envEnabled: boolean;
  tenantFlagEnabled: boolean;
  syncMode: "disabled" | "shadow" | "enforce";
}> {
  const [tenantFlagEnabled, connection] = await Promise.all([
    isFlagEnabledForTenant(tx, ctx.tenantId, CRM_SYNC_FLAG_KEY),
    crmConnectionRepository.getById(tx, ctx.connectionId),
  ]);
  // A connection that has vanished, or is not connected, is treated as disabled rather than as an error:
  // the job is stale, not broken, and a stale job should stop quietly.
  const syncMode =
    connection && connection.status === "connected"
      ? (connection.syncMode as "disabled" | "shadow" | "enforce")
      : "disabled";
  return { envEnabled: env.CRM_SYNC_ENABLED, tenantFlagEnabled, syncMode };
}

/** The credential loader every runner shares — the ONE place a CRM token is decrypted. */
function makeTokenLoader(tx: Tx, ctx: CrmJobContext): () => Promise<CrmTokenBundle> {
  return async () => {
    const held = await crmConnectionRepository.getEncryptedBundle(tx, ctx.connectionId);
    if (!held?.oauthTokenEnc) {
      throw new Error(`crm: connection ${ctx.connectionId} holds no credential`);
    }
    return decryptCrmTokenBundle(held.oauthTokenEnc);
  };
}

/** Bump the run ledger. Shared by every runner; the counters are relative (see the repository). */
function makeCountAdder(tx: Tx, runId: string) {
  return async (counts: Record<string, number>) => {
    await crmSyncRunRepository.addCounts(tx, runId, counts);
  };
}

/**
 * Suppression, computed from the blind index of the incoming email.
 *
 * Returns TRUE (suppressed) when there is no email to check ONLY if a contactId is supplied — otherwise an
 * identity we cannot key on is not evidence of suppression, and refusing everything unkeyable would stop
 * the sync dead on any record without an email. The store is also checked by contactId when we have one, so
 * an erased contact stays blocked even when the CRM stops sending its address.
 */
async function isIdentitySuppressed(
  tx: Tx,
  values: Record<string, unknown>,
  contactId?: string,
): Promise<boolean> {
  const email = typeof values.email === "string" ? values.email.trim().toLowerCase() : null;
  const keys: {
    contactId?: string;
    emailBlindIndex?: Uint8Array | null;
    emailDomain?: string | null;
  } = {};
  if (contactId) keys.contactId = contactId;
  if (email) {
    keys.emailBlindIndex = blindIndex(email);
    const at = email.lastIndexOf("@");
    if (at > 0) keys.emailDomain = email.slice(at + 1);
  }
  if (!keys.contactId && !keys.emailBlindIndex) return false;
  return (await suppressionRepository.findMatch(tx, keys)) !== null;
}

/** Deps for the outbound push of ONE contact. */
export function makePushDeps(tx: Tx, ctx: CrmJobContext, contactId: string): CrmPushDeps {
  return {
    async loadEntity() {
      const [values, provenance] = await Promise.all([
        contactRepository.getScalarValues(tx, contactId),
        contactRepository.getFieldProvenance(tx, contactId),
      ]);
      // getScalarValues returns {} for a row RLS cannot see or that no longer exists — which is exactly the
      // "entity gone" case the runner reports as `missing` rather than pushing an empty record.
      if (Object.keys(values).length === 0) return null;
      return { values, provenance };
    },

    isSuppressed: () => isIdentitySuppressed(tx, {}, contactId),

    async loadLink() {
      const link = await crmRecordLinkRepository.findByContact(tx, ctx.connectionId, contactId);
      if (!link) return null;
      return {
        id: link.id,
        crmRecordId: link.crmRecordId,
        // The stored hash is bytea; the planner compares hex strings.
        lastSyncedHash: link.lastSyncedHash
          ? Buffer.from(link.lastSyncedHash).toString("hex")
          : null,
      };
    },

    async loadMappings() {
      const rows = await crmFieldMappingRepository.listActive(tx, ctx.connectionId, "contact");
      return rows.map(toFieldMapping);
    },

    loadTokenBundle: makeTokenLoader(tx, ctx),

    async recordPushed({ crmRecordId, contentHash }) {
      const linkId = await crmRecordLinkRepository.upsertByCrmRecord(tx, {
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        connectionId: ctx.connectionId,
        tpEntityType: "contact",
        contactId,
        crmObjectType: "Contact",
        crmRecordId,
        externalKey: contactId,
      });
      await crmRecordLinkRepository.markPushed(tx, linkId, Buffer.from(contentHash, "hex"));
    },

    addCounts: makeCountAdder(tx, ctx.runId),
  };
}

/** Deps for applying ONE inbound CRM record. */
export function makeInboundDeps(tx: Tx, ctx: CrmJobContext): CrmInboundDeps {
  return {
    async loadMappings() {
      const rows = await crmFieldMappingRepository.listActive(tx, ctx.connectionId, "contact");
      return rows.map(toFieldMapping);
    },

    loadTokenBundle: makeTokenLoader(tx, ctx),

    async resolveEntity({ crmRecordId, values }) {
      // 1. The link fast-path: this CRM record already maps to a TP contact.
      const link = await crmRecordLinkRepository.findByCrmRecord(
        tx,
        ctx.connectionId,
        "Contact",
        crmRecordId,
      );
      if (link?.contactId) return { entityId: link.contactId, linkId: link.id };

      // 2. The dedup ladder, on the incoming identity.
      const email = typeof values.email === "string" ? values.email.trim().toLowerCase() : null;
      if (!email) return null;
      const hit = await contactRepository.findByDedupKeys(tx, ctx.workspaceId, {
        emailBlindIndex: blindIndex(email),
      });
      return hit ? { entityId: hit.id, linkId: null } : null;
    },

    isSuppressed: (values) => isIdentitySuppressed(tx, values),

    async loadCurrent(entityId) {
      const [values, provenance] = await Promise.all([
        contactRepository.getScalarValues(tx, entityId),
        contactRepository.getFieldProvenance(tx, entityId),
      ]);
      return { values, provenance };
    },

    async persist({ entityId, values, provenance }) {
      // Only the non-PII scalar overlay is written here. Email/phone arrive on the channel write path, which
      // owns encryption + the blind index — duplicating it would give CRM data a second, divergent PII path.
      const writable = {
        firstName: str(values.firstName),
        lastName: str(values.lastName),
        jobTitle: str(values.jobTitle),
        seniorityLevel: str(values.seniorityLevel),
        department: str(values.department),
        locationCountry: str(values.locationCountry),
        locationCity: str(values.locationCity),
        fieldProvenance: provenance,
      };
      if (entityId) {
        await contactRepository.update(tx, entityId, writable);
        return entityId;
      }
      const email = typeof values.email === "string" ? values.email.trim().toLowerCase() : null;
      return contactRepository.insert(tx, {
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        ...writable,
        ...(email
          ? {
              emailEnc: encryptPii(email),
              emailBlindIndex: blindIndex(email),
              emailDomain: email.slice(email.lastIndexOf("@") + 1),
            }
          : {}),
      });
    },

    async recordConflicts(entityId, conflicts) {
      // Staged for human arbitration, never auto-resolved — the live TP value stays as it was. The
      // repository masks PII values on the way in, so a review queue cannot become a second cleartext
      // store for regulated data (§4.7).
      const link = await crmRecordLinkRepository.findByContact(tx, ctx.connectionId, entityId);
      await crmSyncConflictRepository.recordMany(
        tx,
        conflicts.map((c) => ({
          tenantId: ctx.tenantId,
          workspaceId: ctx.workspaceId,
          connectionId: ctx.connectionId,
          recordLinkId: link?.id ?? null,
          objectType: "contact",
          field: c.tpField,
          tpValue: c.tpValue,
          crmValue: c.crmValue,
        })),
      );
    },

    async linkRecord({ entityId, crmRecordId, modstamp }) {
      await crmRecordLinkRepository.upsertByCrmRecord(tx, {
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        connectionId: ctx.connectionId,
        tpEntityType: "contact",
        contactId: entityId,
        crmObjectType: "Contact",
        crmRecordId,
        lastInboundModstamp: modstamp,
      });
    },

    addCounts: makeCountAdder(tx, ctx.runId),
  };
}

/** Deps for a pull page (backfill or delta). `applyRecord` is supplied by the consumer. */
export function makePullDeps(
  tx: Tx,
  ctx: CrmJobContext,
  stateId: string,
  applyRecord: CrmPullDeps["applyRecord"],
): CrmPullDeps {
  return {
    loadTokenBundle: makeTokenLoader(tx, ctx),
    applyRecord,
    addCounts: makeCountAdder(tx, ctx.runId),
    async saveProgress({ cursor, watermark, backfillStatus }) {
      if (backfillStatus !== undefined || cursor !== undefined) {
        await crmSyncStateRepository.setBackfill(
          tx,
          stateId,
          backfillStatus ?? "running",
          cursor ?? null,
        );
      }
      if (watermark) {
        // Monotonic in SQL — a late job for an older window cannot rewind it (see the repository).
        await crmSyncStateRepository.advanceWatermark(tx, stateId, watermark, ctx.runId);
      }
    },
  };
}

/** The overlap window a delta pull reads BEHIND its watermark. */
export const crmOverlapMs = (): number => env.CRM_SYNC_OVERLAP_MS;

// ── local helpers ─────────────────────────────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Repository row → the shared DTO the pure planners consume. */
function toFieldMapping(row: {
  objectType: string;
  tpField: string;
  crmField: string;
  direction: string;
  authority: string;
  confThreshold: string | null;
  transform: string;
  isDedupKey: boolean;
  enabled: boolean;
}): CrmFieldMapping {
  return {
    objectType: row.objectType as CrmFieldMapping["objectType"],
    tpField: row.tpField,
    crmField: row.crmField,
    direction: row.direction as CrmFieldMapping["direction"],
    authority: row.authority as CrmFieldMapping["authority"],
    // numeric(4,3) round-trips as a string in postgres.js; the planner compares numbers.
    confThreshold: row.confThreshold === null ? undefined : Number(row.confThreshold),
    transform: row.transform as CrmFieldMapping["transform"],
    isDedupKey: row.isDedupKey,
    enabled: row.enabled,
  };
}
