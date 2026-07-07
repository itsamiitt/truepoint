// runImport.ts — the load-bearing per-workspace import pipeline (05 §3, ADR-0006). For each parsed row:
// map → normalize → derive blind index + content hash → encrypt PII → (in ONE withTenantTx) idempotency
// check → upsert account by domain → dedup-match the contact (email → linkedin → sales-nav) → insert or
// update → append exactly one source_imports provenance row → (when importing INTO a list, list-plan/03 §2.2)
// add the landed contact to the target list as a `list_members` row (added_via='import', source_import_id set),
// all inside the SAME per-row transaction. Returns the new-vs-matched-vs-skipped tally + the added-to-list
// count. Each row runs in its own tight transaction so one bad row never rolls back the whole import.

import { env } from "@leadwolf/config";
import {
  type ContactWriteValues,
  type Tx,
  accountChildRepository,
  accountRepository,
  contactChannelRepository,
  contactExternalIdRepository,
  contactRepository,
  evidenceRepository,
  listRepository,
  masterGraphRepository,
  sourceImportRepository,
  validationRuleRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import type {
  ColumnMapping,
  ConflictPolicy,
  ImportMergeMode,
  ImportRowError,
  ImportRowOutcome,
  ImportStrategy,
  ImportSummary,
  ImportTarget,
  RejectedRow,
  SourceName,
} from "@leadwolf/types";
import { CONTACT_PROVENANCE_FIELDS, DEFAULT_CONFLICT_POLICY } from "@leadwolf/types";
import { accountDomainsDualWriteEnabledForScope } from "../accounts/accountDualWrite.ts";
import { accountReadFromChildEnabledForScope } from "../accounts/accountRead.ts";
import {
  buildPhoneChannelValue,
  channelDualWriteEnabledForScope,
  countryHintOf,
} from "../channels/channelDualWrite.ts";
import { channelReadFromChildEnabledForScope } from "../channels/channelRead.ts";
import { writeAudit } from "../compliance/writeAudit.ts";
import { companyDomainKey } from "../enrichment/freemailDomains.ts";
import { markConflicts } from "../prospect/conflictDetect.ts";
import { planFieldWrite } from "../prospect/fieldProvenance.ts";
import { assertListInWorkspace } from "../prospect/lists.ts";
import { type ValidationRuleSpec, runValidationRules } from "../validation/index.ts";
import { type RawRow, mapRow } from "./columnMap.ts";
import { contentHash } from "./contentHash.ts";
import { prepareContact, type PreparedContact } from "./prepareContact.ts";
import { rejectLabel, rejectedRowsFor, validateRow } from "./validateRow.ts";

export interface RunImportInput {
  scope: { tenantId: string; workspaceId: string };
  importedByUserId?: string;
  sourceName: SourceName;
  sourceFile?: string;
  mapping: ColumnMapping;
  rows: RawRow[]; // already parsed (parseImportFile)
  /** How to resolve a match against an existing workspace contact (G-IMP-5). Defaults to `skip` (no overwrite).
   *  LEGACY input: when `strategy` is absent it maps onto the 08 §5 triad (compatibility mapping below). */
  conflictPolicy?: ConflictPolicy;
  /** The 08 §5 merge-strategy triad + preserve_populated switch (S-I6, gate-on). SUPERSEDES `conflictPolicy`
   *  when present; expressed through the CANONICAL `planFieldWrite` path (never SQL). Absent ⇒ the legacy
   *  `conflictPolicy` mapping drives the engine, byte-identically. */
  strategy?: ImportStrategy;
  /** P5 delta imports (08 §9 layer 3, S-I-delta). When true, a row's mapped `externalId` (the caller's stable
   *  key) is the TOP dedup rung — resolved BEFORE the email→linkedin→sales-nav ladder (Salesforce-style
   *  upsert-on-external-id) — and is fill-blank-stamped onto the landed contact. The api route sets this ONLY
   *  when the DELTA_IMPORTS dual gate is on, so a gate-off/legacy run never carries it ⇒ the shipped ladder,
   *  byte-identical (the engine never reads or writes contacts.external_id). Additive + default-off. */
  externalIdUpsert?: boolean;
  /**
   * Optional "import into list" target (list-plan/03 §2.2, Phase 2). When set, every landed contact (created,
   * overwritten-match, AND a held-back duplicate / idempotent-skip that resolved to an existing workspace
   * contact) is added to this list as a `list_members` row with `added_via='import'` and `source_import_id`
   * pointing at the appended provenance row (null when no new provenance row was appended). The `listId` is
   * validated against the caller's workspace BEFORE any row runs — a foreign/absent id fails the whole import
   * (the client-supplied id is never trusted; list-plan D4). Absent = land in the overlay with no list linkage.
   */
  target?: ImportTarget;
}

/** The per-row landing outcome. `duplicate` = matched an existing contact and was held back under a `skip`
 *  policy (NOT applied); distinct from `skipped` (an idempotent content-hash re-import no-op). */
type RowLandingOutcome = ImportRowOutcome | "duplicate";

/**
 * The result of landing one row. `contactId` is the workspace contact the row RESOLVED to (the new contact for
 * `created`, the matched contact for `matched`/`duplicate`/`skipped`) — present whenever the row maps to a real
 * workspace contact, so the import-into-list path can add it as a member even when the row itself was a
 * duplicate/idempotent-skip. `sourceImportId` is the appended provenance row (only `created`/`matched` append
 * one; `duplicate`/`skipped` reuse the existing contact and append nothing → null). `addedToList` is whether a
 * NEW membership row was inserted this call (idempotent — false if the contact was already in the list).
 */
interface RowLanding {
  outcome: RowLandingOutcome;
  contactId: string | null;
  sourceImportId: string | null;
  addedToList: boolean;
}

/**
 * Add the landed contact to the import's target list (list-plan/03 §2.2) inside the SAME per-row transaction,
 * with `added_via='import'` and the appended provenance row id. Idempotent (ON CONFLICT DO NOTHING upstream):
 * a contact already in the list is a no-op. Returns whether a NEW membership row was created.
 *
 * The contactId is filtered through `visibleContactIds` first — exactly like the manual add path
 * (`addContactsToList`), which is the cross-workspace + soft-delete guard: it links only a LIVE
 * (deletedAt IS NULL) contact in the caller's workspace under RLS. This matters on the duplicate/skip paths,
 * where the matched contact may be a since-archived/DSAR-tombstoned row (the dedup lookups don't exclude
 * soft-deleted contacts) — re-adding such a contact would create a dangling member the masked read then hides.
 */
async function addLandedToList(
  tx: Tx,
  input: RunImportInput,
  listId: string,
  contactId: string,
  sourceImportId: string | null,
): Promise<boolean> {
  const visible = await listRepository.visibleContactIds(tx, [contactId]);
  if (visible.length === 0) return false; // soft-deleted/foreign contact — never link it
  const inserted = await listRepository.addMembers(tx, {
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId,
    listId,
    addedByUserId: input.importedByUserId ?? null,
    contactIds: visible,
    addedVia: "import",
    sourceImportId,
  });
  return inserted > 0;
}

/** The Layer-0 golden ids a landing row resolves to. Both null when resolution was skipped or failed. */
interface ResolvedMaster {
  masterPersonId: string | null;
  masterCompanyId: string | null;
}

const NO_MASTER: ResolvedMaster = { masterPersonId: null, masterCompanyId: null };

/**
 * Co-op-safe MATCH-AGAINST resolution for a LANDING row (PLAN_02 §1.4, ADR-0021): LINK the contact's identity
 * to an existing Layer-0 master person/company or co-op-safely MINT one, returning the bridge ids the overlay
 * write stamps onto `contacts.master_person_id` / `accounts.master_company_id`. Runs in its OWN transaction
 * under the least-privilege `leadwolf_er` role (`withErTx`) — a different role/connection than the per-row
 * `withTenantTx` overlay tx, because `leadwolf_app` has NO grant on the master_* tables (isolation by access
 * path, PLAN_02 RLS). The resolver input is identity + blind-index dedup keys ONLY — never a revealable PII
 * value. The company key is gated through `companyDomainKey` so a freemail/role domain (gmail.com) yields no
 * company key → no company mint (F4); it prefers the explicit account domain, falling back to the email's
 * domain. Resolution is NON-FATAL: the bridges are nullable in-flight-staging columns (PLAN_00 C4, ADR-0021),
 * so on any error we log and return both null, leaving the row to land with null bridges (backfilled later) —
 * a resolution failure must NEVER fail the row's landing.
 */
async function resolveMasterForLanding(prepared: PreparedContact): Promise<ResolvedMaster> {
  try {
    const registrableDomain =
      companyDomainKey(prepared.accountDomain) ?? companyDomainKey(prepared.values.emailDomain);
    const input = {
      linkedinPublicId: prepared.values.linkedinPublicId ?? undefined,
      emailBlindIndex: prepared.values.emailBlindIndex ?? undefined,
      emailDomain: prepared.values.emailDomain ?? undefined,
      registrableDomain,
      companyName: prepared.accountName,
    };
    const { masterPersonId, masterCompanyId } = await withErTx((tx2) =>
      masterGraphRepository.resolveForImport(tx2, input),
    );
    return { masterPersonId, masterCompanyId };
  } catch (err) {
    // In-flight staging: never fail the landing on a resolution error — land with null bridges (ADR-0021).
    console.error("[import] master resolution failed; landing with null bridges", err);
    return NO_MASTER;
  }
}

/**
 * I0 evidence dual-write (prospect-database-platform; audit P01), BEHIND INGESTION_EVIDENCE_ENABLED. Appends the
 * immutable source_records evidence row for this LANDED row + its match_links cluster membership, in their OWN
 * withErTx (the master-graph write role). NON-FATAL + idempotent (content-hash): a failure logs and never fails
 * the landing, and an identical re-ingest does not double-link. The shipped golden landing stays authoritative —
 * the survivorship projector reading this log is a SEPARATE, CI-parity-gated flip.
 */
async function recordImportEvidence(
  input: RunImportInput,
  raw: RawRow,
  hash: Uint8Array,
  resolved: ResolvedMaster,
  prepared: PreparedContact,
): Promise<void> {
  try {
    await withErTx(async (tx) => {
      const ev = await evidenceRepository.appendSourceRecord(tx, {
        sourceName: input.sourceName,
        contentHash: hash,
        rawData: raw,
        matchKeys: {
          emailDomain: prepared.values.emailDomain ?? undefined,
          linkedinPublicId: prepared.values.linkedinPublicId ?? undefined,
        },
        resolvedPersonId: resolved.masterPersonId,
        resolvedCompanyId: resolved.masterCompanyId,
      });
      if (!ev || !ev.created) return; // idempotent re-ingest → don't double-link
      if (resolved.masterPersonId) {
        await evidenceRepository.linkToCluster(tx, {
          entityType: "person",
          clusterId: resolved.masterPersonId,
          sourceRecordId: ev.id,
        });
        // Enqueue a survivorship re-projection for the cluster (I1 / Phase 05). The projector worker rebuilds the
        // golden record from the evidence log; until that worker + the authoritative flip ship, this is just a queue.
        await evidenceRepository.enqueueProjection(tx, {
          entityType: "person",
          clusterId: resolved.masterPersonId,
          reason: "evidence_added",
        });
      }
      if (resolved.masterCompanyId) {
        await evidenceRepository.linkToCluster(tx, {
          entityType: "company",
          clusterId: resolved.masterCompanyId,
          sourceRecordId: ev.id,
        });
        await evidenceRepository.enqueueProjection(tx, {
          entityType: "company",
          clusterId: resolved.masterCompanyId,
          reason: "evidence_added",
        });
      }
    });
  } catch (err) {
    console.error("[import] evidence dual-write failed (non-fatal; flag-gated)", err);
  }
}

/**
 * Legacy `conflictPolicy` → 08 §5 strategy triad (the compatibility mapping): `skip` → `create_only`,
 * `overwrite` → `create_and_update`, `keep_both` → `create_only` (retired — no market analog; it manufactured
 * the duplicates the review queue exists to prevent, so a legacy submission carrying it is treated as
 * `create_only`). Legacy always maps to `preservePopulated:false` (there was no such switch), so the gate-off
 * internal path stays BYTE-IDENTICAL: `create_only` reproduces the old skip/keep_both held-back-duplicate
 * branch, and `create_and_update` reproduces the old overwrite update branch; `update_only` is unreachable.
 */
function conflictPolicyToStrategy(policy: ConflictPolicy): ImportStrategy {
  const mergeMode: ImportMergeMode = policy === "overwrite" ? "create_and_update" : "create_only";
  return { mergeMode, preservePopulated: false };
}

/**
 * S-CH2 channel dual-write (05 §5/§6) + S-C6 match-time duplicate SIGNALS (04 §2), called on LANDING rows
 * only, gate-on only, INSIDE the same per-row withTenantTx as the flat write — CH-INV-1's same-tx rule. The
 * email child row reuses the EXACT prepared ciphertext/blind-index bytes the flat write carried (byte-identical
 * projection); the phone child row is built from the cleaned plaintext prepareContact carried (raw-digits blind
 * index + derived E.164; country hint = the row's ISO-2 locationCountry when present — 05 §4.2's S-CH2 slice).
 * A genuine DB error aborts the row's tx WITH the flat write, atomically. The import bulk path writes NO per-row
 * channel audit (05 §3.3: import never flips a primary; channel_* audit actions are the user-verb writers').
 *
 * S-C6 warning band (`markSignals`, rides the S-CH4 read gate — 15 §M-SEQ seq 50): when the child tables are
 * authoritative, two match-time signals the three-partial-unique ladder CANNOT express as a conflict are
 * surfaced as duplicate_of_contact_id SUGGESTIONS (never an upsert/merge/block — the MATCH-vs-ACT split,
 * 03 §2.1 [34]) toward the signalled contact, feeding the review queue (G21, doc 11):
 *   • cross-key EMAIL collision (05 §2.2): the row's email value is live on ANOTHER contact than the one this
 *     row landed on (the email ws-unique is held elsewhere) ⇒ suggest the landed contact is a dup of the owner.
 *   • phone-signal-ONLY match (04 §2 act layer): a NEWLY created contact (`matched` false) whose phone E.164
 *     matches an existing contact — phone is a dedup key nowhere (shared lines legal), so it never matched the
 *     ladder, but the shared line is a review signal. Skipped for matched rows (an update already resolved
 *     identity) and when the phone is unparseable (no E.164 blind index to probe).
 */
async function writeChannelRows(
  tx: Tx,
  input: RunImportInput,
  prepared: PreparedContact,
  contactId: string,
  sourceImportId: string | null,
  markSignals: boolean,
  matched: boolean,
): Promise<void> {
  const source = `import:${input.sourceName}`;
  const v = prepared.values;
  const { workspaceId } = input.scope;
  if (v.emailEnc && v.emailBlindIndex && v.emailDomain) {
    const emailBlindIndex = v.emailBlindIndex;
    const outcome = await contactChannelRepository.applyChannelWrite(tx, input.scope, {
      kind: "email_upsert",
      contactId,
      value: {
        valueEnc: v.emailEnc,
        blindIndex: emailBlindIndex,
        emailDomain: v.emailDomain,
        type: "work", // the import's single mapped email column is the work-email slot (05 §6 mapping)
        source,
        sourceImportId,
      },
    });
    if (outcome.result === "collision" || outcome.result === "capped") {
      // Non-PII operational signal only (contact id + outcome — never a value).
      console.warn(`[import] channel email ${outcome.result} (contact ${contactId})`);
    }
    // S-C6 cross-key email collision → duplicate suggestion toward the value's owner (never an act).
    if (markSignals && outcome.result === "collision") {
      const owners = await contactChannelRepository.findContactIdsByEmailBlindIndexes(tx, workspaceId, [
        emailBlindIndex,
      ]);
      const owner = owners.find((h) => h.contactId !== contactId);
      if (owner && (await contactRepository.markDuplicateSuggestion(tx, contactId, owner.contactId))) {
        console.warn(`[import] dup signal: email collision (contact ${contactId} → ${owner.contactId})`);
      }
    }
  }
  if (prepared.phoneRaw && v.phoneEnc) {
    const built = buildPhoneChannelValue({
      cleaned: prepared.phoneRaw,
      phoneEnc: v.phoneEnc,
      countryHint: countryHintOf(v.locationCountry),
    });
    const outcome = await contactChannelRepository.applyChannelWrite(tx, input.scope, {
      kind: "phone_upsert",
      contactId,
      value: { ...built, type: "work", source, sourceImportId },
    });
    if (outcome.result === "capped") {
      console.warn(`[import] channel phone capped (contact ${contactId})`);
    }
    // S-C6 phone-signal-ONLY match → duplicate suggestion toward the other holder of this E.164. Only for a
    // NEWLY created contact (a matched row already resolved identity); needs a parseable E.164 to probe. The
    // just-written row on `contactId` is filtered out; a hit on any OTHER live contact is the shared-line
    // signal the human reviews (never an upsert — phones are a dedup key nowhere, 05 §2.2).
    if (markSignals && !matched && built.e164BlindIndex) {
      const holders = await contactChannelRepository.findContactIdsByPhoneE164BlindIndexes(
        tx,
        workspaceId,
        [built.e164BlindIndex],
      );
      const other = holders.find((h) => h.contactId !== contactId);
      if (other && (await contactRepository.markDuplicateSuggestion(tx, contactId, other.contactId))) {
        console.warn(`[import] dup signal: phone match (contact ${contactId} → ${other.contactId})`);
      }
    }
  }
}

async function importOneRow(
  tx: Tx,
  input: RunImportInput,
  raw: RawRow,
  prepared: PreparedContact,
  hash: Uint8Array,
  strategy: ImportStrategy,
  channelDualWrite: boolean,
  channelReadFromChild: boolean,
  accountDualWrite: boolean,
  accountReadFromChild: boolean,
): Promise<RowLanding> {
  const { tenantId, workspaceId } = input.scope;
  const listId = input.target?.listId;

  // Identical payload already imported into this workspace → no-op (idempotent re-import). The existing contact
  // is still added to the target list (membership is the point of the import) but no second provenance row is
  // appended — the prior import already recorded the lineage (list-plan/03 §2.2).
  const priorImport = await sourceImportRepository.findByContentHash(tx, workspaceId, hash);
  if (priorImport) {
    const addedToList = listId
      ? await addLandedToList(tx, input, listId, priorImport.contactId, null)
      : false;
    return {
      outcome: "skipped",
      contactId: priorImport.contactId,
      sourceImportId: null,
      addedToList,
    };
  }

  // ALWAYS look up the match first — even for keep_both. The overlay enforces ONE contact per identity key
  // per workspace via the partial unique indexes (workspace_id, email_blind_index) /
  // (workspace_id, linkedin_public_id) / (workspace_id, sales_nav_lead_id) — 03 §5/§11. A blind insert on an
  // existing identity would just throw a unique-constraint violation, so we resolve the conflict in app code.
  // Computed BEFORE the account upsert + master resolution so a held-back duplicate touches NEITHER (a row
  // that does not land never mints a master node nor stamps an account — resolve only on landing rows).
  //
  // P5 DELTA rung (08 §9 layer 3): when `externalIdUpsert` is on (the DELTA_IMPORTS dual gate resolved to true
  // in the route) AND the row carries a mapped `externalId`, the caller's stable key is the TOP dedup rung —
  // probed BEFORE the email→linkedin→sales-nav ladder (Salesforce-style upsert-on-external-id: the caller
  // declared THIS is the record's identity). A hit resolves the row to that contact directly; a miss FALLS
  // THROUGH to the shipped ladder unchanged (the row still needs an intrinsic identity key to land — the
  // overlay has no external-id-only contact, prepareContact throws otherwise; doc 16 caveat). Gate-off/absent
  // ⇒ this probe is skipped entirely and the ladder runs byte-identically (zero external_id queries).
  const externalMatch =
    input.externalIdUpsert && prepared.externalId
      ? await contactExternalIdRepository.findIdByExternalId(tx, workspaceId, prepared.externalId)
      : null;
  const match =
    externalMatch ??
    (await contactRepository.findByDedupKeys(tx, workspaceId, prepared.dedupKeys, {
      channelsFromChild: channelReadFromChild,
    }));

  // create_only (08 §5 — and the legacy skip/keep_both that maps to it): a matched contact is a held-back
  // DUPLICATE — kept untouched, counted as a duplicate (no provenance row appended), but still added to the
  // target list (membership is the point of an "import into list"). This path does NOT land → no master
  // resolution, no account upsert. (keep_both had no separate-record home in the one-per-identity overlay —
  // ER's domain, 30 §5/ADR-0021 — so mapping it to create_only holds the match back instead of throwing a
  // unique-constraint error on an insert that can never succeed.)
  if (match && strategy.mergeMode === "create_only") {
    const addedToList = listId ? await addLandedToList(tx, input, listId, match.id, null) : false;
    return { outcome: "duplicate", contactId: match.id, sourceImportId: null, addedToList };
  }

  // update_only MISS (08 §5.3): no existing contact to update ⇒ the row is SKIPPED with code
  // `no_match_update_only` (a SKIP, never a reject — HubSpot's mode-violation class). It does not land, mints
  // nothing, and joins no list. Reachable only when the strategy is explicitly update_only (gate-on); the
  // legacy mapping never produces update_only, so the gate-off path never reaches this branch.
  if (!match && strategy.mergeMode === "update_only") {
    return { outcome: "skipped", contactId: null, sourceImportId: null, addedToList: false };
  }

  // ── LANDING ROW (created, or overwrite→matched) ──────────────────────────────────────────────────────────
  // Co-op-safe MATCH-AGAINST resolution runs BEFORE the overlay write, in its OWN `withErTx` tx (leadwolf_er) —
  // OUTSIDE this per-row `withTenantTx` (leadwolf_app has no master_* grant; PLAN_02 §1.4, ADR-0021). The
  // bridge ids are nullable in-flight staging, so a resolution failure leaves them null and the row still lands.
  const resolved = await resolveMasterForLanding(prepared);
  const { masterPersonId, masterCompanyId } = resolved;
  // I0 evidence dual-write (flag-off by default → no-op; audit P01). Additive + non-fatal; never affects the
  // golden landing below.
  if (env.INGESTION_EVIDENCE_ENABLED) await recordImportEvidence(input, raw, hash, resolved, prepared);

  // Company match ladder (06 §5), over LIVE rows only. `prepared.accountDomain` is already DM1-normalized
  // (prepareContact), the exact form both accounts.domain and account_domains store — so no re-normalization.
  //   • C1 — primary-domain exact (the flat accounts.domain cache): accountRepository.upsertByDomain's atomic
  //     INSERT…ON CONFLICT resolves a primary hit (name-refresh + master-bridge) OR mints on a true miss.
  //   • C2 — any-live-SECONDARY-domain exact (S-A6, gate-on ONLY): BEFORE the C1 upsert would mint a duplicate
  //     for a domain that is actually a live secondary of an existing account, resolve to THAT account and
  //     proceed as an update (06 §5 whole-set rule; the G17 payoff). ≥2 hits impossible by the ws-domain live
  //     unique. NEVER moves/re-primaries the domain (06 §Edge). Gate-off ⇒ the probe is skipped and only the C1
  //     upsert runs — byte-identical to today (zero account_domains queries).
  //   • C3 — name+country — REVIEW-ONLY, not an import key: absent from this write path by design (06 §5).
  let accountId: string | undefined;
  if (prepared.accountDomain) {
    const accountName = prepared.accountName ?? prepared.accountDomain;
    const c2AccountId = accountReadFromChild
      ? await accountChildRepository.findAccountIdBySecondaryDomain(
          tx,
          workspaceId,
          prepared.accountDomain,
        )
      : null;
    if (c2AccountId) {
      // C2 secondary-domain match: resolve to the existing account and refresh it as C1's update would; never
      // attach the domain here (import never moves a domain — 06 §1/§Edge; the whole live set is already the
      // account's, and a domain that is elsewhere-owned would have failed the ws-unique upstream).
      accountId = c2AccountId;
      await accountRepository.refreshMatchedAccount(tx, c2AccountId, {
        name: accountName,
        masterCompanyId: masterCompanyId ?? undefined,
      });
    } else {
      accountId = await accountRepository.upsertByDomain(tx, {
        tenantId,
        workspaceId,
        name: accountName,
        domain: prepared.accountDomain,
        // Overlay → Layer-0 bridge (contacts.ts:50): set the account's golden company when ER resolved one.
        masterCompanyId: masterCompanyId ?? undefined,
      });
    }
  }

  const values: ContactWriteValues = {
    ...prepared.values,
    tenantId,
    workspaceId,
    accountId: accountId ?? null,
    // Overlay → Layer-0 bridge (contacts.ts:112): only the uuid is added to the leadwolf_app write — the FK
    // referential check runs at owner privilege, so no master_* grant is needed. Nullable when unresolved.
    masterPersonId: masterPersonId ?? undefined,
  };

  // PLAN_03 §1.4 — the import-overwrite path respects the field-provenance pin (Phase 3 overlay), exactly like
  // enrichment: a user-pinned SCALAR profile field (jobTitle/department/…) must NOT be clobbered by a blind
  // last-writer-wins import. The SCALAR fields are the pin-protected subset of this row's write
  // (CONTACT_PROVENANCE_FIELDS); the non-scalar fields (email/phone/linkedin/sales-nav/master/account) are NOT
  // pin-gated and are written as before. Every scalar the import does write is stamped `{src:'import:<source>'}`.
  const scalarFields = Object.keys(prepared.values).filter((f) =>
    (CONTACT_PROVENANCE_FIELDS as readonly string[]).includes(f),
  );

  let contactId: string;
  let outcome: RowLandingOutcome;
  if (match) {
    // Matched under an UPDATING mode (create_and_update / update_only). Plan the SCALAR write against the
    // existing provenance so a PINNED (user-corrected) scalar survives EVERY strategy unconditionally (DM6 —
    // the pin is the user's override of all automation): drop every pinned scalar key from `values`, then
    // stamp `import:<source>` provenance on the scalars we DO write.
    const existingProv = await contactRepository.getFieldProvenance(tx, match.id);
    const planned = planFieldWrite(existingProv, scalarFields, { src: `import:${input.sourceName}` });
    let written = planned.writableFields;
    let provenance = planned.provenance;
    // preserve_populated (08 §5.1 — the orthogonal switch): an update never overwrites an already-POPULATED
    // target, only fills blanks. Drop every writable scalar whose existing value is non-empty; re-plan
    // provenance over the reduced set so a preserved field keeps its PRIOR descriptor (never re-stamped as
    // import-written). Gate-off/legacy always has preservePopulated=false ⇒ `written`/`provenance` unchanged,
    // so this is byte-identical when off; guarded so a values read can never fail the row.
    if (strategy.preservePopulated && written.size > 0) {
      try {
        const existingScalar = (await contactRepository.getScalarValues(tx, match.id)) as Record<
          string,
          unknown
        >;
        const kept = new Set<string>();
        for (const f of written) {
          const v = existingScalar[f];
          if (v === null || v === undefined || v === "") kept.add(f); // blank target — import may fill it
        }
        if (kept.size !== written.size) {
          written = kept;
          provenance = planFieldWrite(existingProv, [...kept], {
            src: `import:${input.sourceName}`,
          }).provenance;
        }
      } catch (err) {
        console.error("[import] preserve_populated check failed (non-fatal)", err);
      }
    }
    for (const f of scalarFields) {
      if (!written.has(f)) delete (values as unknown as Record<string, unknown>)[f];
    }
    // data-management #8 — flag TRUE cross-source conflicts on the scalars we overwrite. ADDITIVE + fully GUARDED:
    // any failure falls back to the plain provenance, so conflict detection can NEVER fail or alter the import.
    let mergedProvenance = provenance;
    try {
      const existingValues = await contactRepository.getScalarValues(tx, match.id);
      mergedProvenance = markConflicts({
        provenance,
        existingProvenance: existingProv,
        existingValues,
        incomingValues: prepared.values as unknown as Record<string, unknown>,
        writtenFields: written,
        incomingSrc: `import:${input.sourceName}`,
      });
    } catch (err) {
      console.error("[import] conflict detection failed (non-fatal)", err);
    }
    values.fieldProvenance = mergedProvenance;
    await contactRepository.update(tx, match.id, values);
    contactId = match.id;
    outcome = "matched";
  } else {
    // A NEW contact has no pin to respect, but record a provenance baseline for the scalars it writes so a later
    // enrichment knows these came from this import (and may overwrite them — they are unpinned, `pin:false`).
    const { provenance } = planFieldWrite({}, scalarFields, { src: `import:${input.sourceName}` });
    values.fieldProvenance = provenance;
    contactId = await contactRepository.insert(tx, values);
    outcome = "created";
  }

  // P5 DELTA (08 §9 layer 3): fill-blank-stamp the caller's external key onto the landed contact (insert OR
  // update). FILL-BLANK — never overwrites a populated/different key (08 §9 conflict deference); a new insert
  // (external_id NULL) gets it, a row matched BY external_id already holds it (no-op), a row matched by email
  // whose contact has a different key keeps the stored one. Same-tx as the write. Only runs with the option on
  // AND a mapped key ⇒ gate-off is a no-op (zero writes). A workspace collision on a fresh stamp throws at the
  // partial unique and aborts THIS row's tx (surfaced as a per-row processing_error — the correct outcome).
  if (input.externalIdUpsert && prepared.externalId) {
    await contactExternalIdRepository.setExternalId(tx, contactId, prepared.externalId);
  }

  const sourceImportId = await sourceImportRepository.append(tx, {
    tenantId,
    workspaceId,
    contactId,
    importedByUserId: input.importedByUserId ?? null,
    sourceName: input.sourceName,
    sourceFile: input.sourceFile ?? null,
    rawData: raw,
    contentHash: hash,
  });

  // S-CH2 channel dual-write — LANDING rows only (a held-back duplicate/idempotent skip wrote no flat
  // channel value, so it writes no child row either — 05 §3 cache coherence), gate-on only, same tx. The
  // S-C6 match-time duplicate SIGNALS ride the S-CH4 read gate (`channelReadFromChild` — 15 §M-SEQ seq 50);
  // `!!match` tells writeChannelRows whether this row created a new contact (phone-signal-only fires there).
  if (channelDualWrite) {
    await writeChannelRows(tx, input, prepared, contactId, sourceImportId, channelReadFromChild, !!match);
  }

  // S-A2 account-domain dual-write — the account writer (upsertByDomain above) that sets accounts.domain also
  // maintains the child domain row + the flat primary cache via the ONE write path, same tx, gate-on only
  // (06 §1). LANDING rows that carry a domain only (a held-back duplicate/idempotent skip returned earlier and
  // stamped no account). A domain live on ANOTHER account ⇒ `collision` (06 §1 match signal — never an error,
  // never a move; the C2 ladder rung that resolves it is S-A6's). Gate-off ⇒ this block is skipped entirely
  // (zero child-table queries — the flat account write above is byte-identical to today).
  if (accountDualWrite && accountId && prepared.accountDomain) {
    const outcome = await accountChildRepository.applyAccountDomainWrite(tx, input.scope, {
      kind: "domain_upsert",
      accountId,
      value: { domain: prepared.accountDomain, source: "import", sourceImportId },
    });
    if (outcome.result === "collision") {
      // Non-PII operational signal only (account id + outcome — never a value).
      console.warn(`[import] account domain collision (account ${accountId})`);
    }
  }

  // A landed row (created or overwritten match) joins the target list, linked to THIS import's provenance row.
  const addedToList = listId
    ? await addLandedToList(tx, input, listId, contactId, sourceImportId)
    : false;
  return { outcome, contactId, sourceImportId, addedToList };
}

/**
 * Load the ENABLED custom data-quality rules once for an import (database-management-research 06). FAIL-OPEN: a
 * rules-read hiccup must never block an import — the custom rules are an added quality gate, not a correctness
 * invariant — so on error we log and enforce nothing. Built-in checks are deliberately NOT loaded here (they would
 * reject LinkedIn-only / nameless rows the pipeline otherwise accepts); only staff-authored custom rules apply.
 */
async function loadEnabledValidationRules(scope: RunImportInput["scope"]): Promise<ValidationRuleSpec[]> {
  try {
    const rows = await withTenantTx(scope, (tx) => validationRuleRepository.listEnabledForImport(tx));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      field: r.field,
      checkType: r.checkType as ValidationRuleSpec["checkType"],
      config: (r.config ?? {}) as ValidationRuleSpec["config"],
    }));
  } catch (err) {
    console.error("[import] failed to load validation rules; proceeding without them", err);
    return [];
  }
}

/**
 * Run a full per-workspace import and return the accounting summary (30 §4): created / matched / skipped /
 * duplicates / rejected + addedToList, plus the rejected-rows artifact. A row that fails validation is REJECTED
 * (collected with per-field reasons for the downloadable error file, G-IMP-1) — it never reaches the DB; a row
 * that matches under a `skip` conflict policy is a DUPLICATE (held back); everything else lands. When an
 * `input.target` list is set (list-plan/03 §2.2) every contact a row resolves to (created/matched/duplicate/
 * skipped) is added to that list (`added_via='import'`); the target is validated against the caller's workspace
 * up-front, so a foreign/absent list id fails the whole import before any row is processed (list-plan D4).
 */
export async function runImport(input: RunImportInput): Promise<ImportSummary> {
  const policy: ConflictPolicy = input.conflictPolicy ?? DEFAULT_CONFLICT_POLICY;
  // 08 §5 strategy triad (S-I6): the explicit per-import strategy (gate-on) wins; otherwise the legacy
  // conflictPolicy maps onto the triad so the gate-off internal path is byte-identical (create_only/
  // create_and_update reproduce the old skip/keep_both/overwrite branches exactly, preservePopulated=false).
  const strategy: ImportStrategy = input.strategy ?? conflictPolicyToStrategy(policy);
  // Trust boundary: validate the import-into-list target against the caller's workspace BEFORE any row runs.
  // Reuses the same guard the manual add path + the API edge use (assertListInWorkspace → NotFoundError on a
  // foreign/absent id), so a bad list id fails the whole import fast and consistently — the client id is never
  // trusted (list-plan D4). No-op when there is no target.
  if (input.target) {
    await assertListInWorkspace({ scope: input.scope, listId: input.target.listId });
  }

  // The global custom data-quality rules (database-management-research 06), loaded ONCE. Empty unless staff have
  // authored rules → no behaviour change for an import with none. Reject-on-fail, additive to validateRow below.
  const validationRules = await loadEnabledValidationRules(input.scope);

  // S-CH2 dual gate (05 §Implementation Steps), evaluated ONCE per run (a 10k-row import must not re-read
  // the flag per row; fail-closed on error). env.CHANNEL_DUAL_WRITE off ⇒ false with ZERO queries — the
  // gate-off run is cost-identical as well as byte-identical (T-CH parity).
  const channelDualWrite = await channelDualWriteEnabledForScope(input.scope);
  // S-CH4 read cutover (05 §6), evaluated ONCE per run (fail-closed on error ⇒ flat dedup; env off ⇒ zero
  // queries). Gate-on the email dedup rung resolves via contact_emails.blind_index so a duplicate carrying a
  // SECONDARY email lands on the contact that already holds it (the G15/G16 payoff); gate-off byte-identical.
  const channelReadFromChild = await channelReadFromChildEnabledForScope(input.scope);
  // S-A2 account-domain dual gate (06 §1), evaluated ONCE per run (a 10k-row import must not re-read the flag
  // per row; fail-closed on error). env.ACCOUNT_DOMAINS_DUAL_WRITE off ⇒ false with ZERO queries — the
  // gate-off run's account writes are cost-identical as well as byte-identical (the T-P4 parity gate).
  const accountDualWrite = await accountDomainsDualWriteEnabledForScope(input.scope);
  // S-A6 account READ CUTOVER (06 §5/§6), evaluated ONCE per run (fail-closed on error ⇒ C1-only; env off ⇒
  // zero queries). Gate-on activates ladder rung C2: a domain that is a live SECONDARY of an existing account
  // resolves to that account instead of minting a duplicate (the G17 payoff). Read implies dual-write, so this
  // can only be true when accountDualWrite is also effectively on. Gate-off byte-identical (C1-only).
  const accountReadFromChild = await accountReadFromChildEnabledForScope(input.scope);

  const errors: ImportRowError[] = [];
  const rejectedRows: RejectedRow[] = [];
  // A per-import reject breakdown keyed by a STABLE, NON-PII label (never a row value) — one bump per rejected row
  // (its primary reason), so the histogram sums to the distinct rejected-row count. Surfaced to staff on the import
  // drill-down (database-management-research G08). Categorized at the SOURCE below so a free-text catch-path message
  // (which may embed a value) is bucketed as a generic "Processing error", never surfaced verbatim.
  const rejectHistogram: Record<string, number> = {};
  const bumpReject = (field: string | null, kind: "validation" | "rule" | "error"): void => {
    const label = rejectLabel(field, kind);
    rejectHistogram[label] = (rejectHistogram[label] ?? 0) + 1;
  };
  let created = 0;
  let matched = 0;
  let skipped = 0;
  let duplicates = 0;
  let addedToList = 0;

  for (let i = 0; i < input.rows.length; i++) {
    const raw = input.rows[i]!;

    // Pre-flight validation = the same verdict the preview uses, so a row rejected in the preview is rejected
    // here with identical per-field reasons (the rejected-rows artifact). Rejected rows never touch the DB.
    const verdict = validateRow(raw, input.mapping);
    if (!verdict.ok) {
      rejectedRows.push(...rejectedRowsFor(i, raw, verdict.reasons));
      bumpReject(verdict.reasons[0]?.field ?? null, "validation");
      errors.push({ row: i, message: verdict.reasons[0]?.reason ?? "Row rejected." });
      continue;
    }

    // Staff custom data-quality rules (reject-on-fail, database-management-research 06): run them over the mapped
    // row; any failure rejects the row with its per-field reason (built-ins are NOT enforced here). A failed row
    // never reaches the DB — identical treatment to a validateRow rejection.
    if (validationRules.length > 0) {
      const ruleFailures = runValidationRules(verdict.mapped as Record<string, unknown>, validationRules);
      if (ruleFailures.length > 0) {
        rejectedRows.push(
          ...ruleFailures.map((f) => ({
            row: i,
            field: f.field,
            reason: f.message,
            code: "validation_rule_failed" as const,
            raw,
          })),
        );
        bumpReject(ruleFailures[0]!.field, "rule");
        errors.push({ row: i, message: ruleFailures[0]!.message });
        continue;
      }
    }

    try {
      const mapped = mapRow(raw, input.mapping);
      const prepared = prepareContact(mapped);
      const hash = contentHash({ mapped, sourceName: input.sourceName });
      const landing = await withTenantTx(input.scope, (tx) =>
        importOneRow(
          tx,
          input,
          raw,
          prepared,
          hash,
          strategy,
          channelDualWrite,
          channelReadFromChild,
          accountDualWrite,
          accountReadFromChild,
        ),
      );
      if (landing.outcome === "created") created++;
      else if (landing.outcome === "matched") matched++;
      else if (landing.outcome === "duplicate") duplicates++;
      else skipped++;
      if (landing.addedToList) addedToList++;
    } catch (err) {
      // A DB/constraint failure after validation passed: surface it as a reject (it did not land). The typed
      // code is the BUCKETED `processing_error` — the free-text `message` (which may embed a value) is NEVER
      // what the ledger token or the error report exposes (13 §3.3); it survives only in the gated repair CSV.
      const message = err instanceof Error ? err.message : String(err);
      rejectedRows.push({ row: i, field: null, reason: message, code: "processing_error", raw });
      bumpReject(null, "error");
      errors.push({ row: i, message });
    }
  }

  // Customer-visible audit (list-plan/03 §2.2): one member.add row per import carrying the count that newly
  // joined the list (not per contact — a 10k-row import must not write 10k audit rows). Its own tx so it
  // commits regardless of which per-row txs landed; skipped when the import had no list target or added nobody.
  if (input.target && addedToList > 0) {
    await withTenantTx(input.scope, (tx) =>
      writeAudit(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        actorUserId: input.importedByUserId ?? null,
        action: "member.add",
        entityType: "list",
        entityId: input.target!.listId,
        metadata: { affected: addedToList, via: "import" },
      }),
    );
  }

  // `rejected` is the count of distinct rejected INPUT rows (rejectedRows may hold >1 reason per row).
  const rejected = new Set(rejectedRows.map((r) => r.row)).size;
  return {
    total: input.rows.length,
    created,
    matched,
    skipped,
    rejected,
    duplicates,
    addedToList,
    errors,
    rejectedRows,
    rejectHistogram,
  };
}
