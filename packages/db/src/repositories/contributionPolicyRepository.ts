// contributionPolicyRepository.ts — read/write access to the Phase 4 contribution controls
// (contribution_policy / contribution_exclusion / crm_object_contribution, migration 0097).
//
// Runs under withTenantTx (leadwolf_app) — the tables are workspace-scoped and RLS-enforced, so isolation
// rides the transaction GUCs and no query here carries an explicit workspace predicate. That is deliberate and
// load-bearing: a reader that filtered in SQL instead would silently keep working if the policy were ever
// dropped, which is the failure mode RLS exists to make impossible.
//
// Raw SQL rather than a Drizzle schema, matching the sibling hand-authored tables (entitlement, usage_event,
// provenance_event): those three carry no pgTable either, so `drizzle generate` neither knows nor tries to
// drop them.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

/** Everything the per-row contribution gate needs, loaded once per batch. */
export interface ResolvedContributionPolicy {
  /**
   * The Phase-3 CO-OP opt-in — whether this workspace agreed to contribute actual VALUES to the shared graph.
   * Default false and read by nothing yet. It is NOT what gates the identity mint: that mint is ADR-0021's
   * MATCH-AGAINST path, which the repo already treats as the contribute-off state (decisions.md D13).
   */
  contributeEnabled: boolean;
  /** Facets withheld from the identity mint. Enforced ALWAYS, independent of contributeEnabled. */
  neverShareFields: string[];
  excludedDomains: Set<string>;
  excludedAccountIds: Set<string>;
  excludedContactIds: Set<string>;
}

/**
 * The policy a workspace with NO row and NO exclusions has: the co-op opt-in off, and nothing restricted.
 *
 * Empty lists mean the identity mint behaves exactly as it did before these tables existed — which is the
 * point. The controls SUBTRACT from shipped behaviour on the customer's instruction; they do not switch it
 * off by default and wait to be switched back on (D13).
 */
export function defaultContributionPolicy(): ResolvedContributionPolicy {
  return {
    contributeEnabled: false,
    neverShareFields: [],
    excludedDomains: new Set(),
    excludedAccountIds: new Set(),
    excludedContactIds: new Set(),
  };
}

export const contributionPolicyRepository = {
  /**
   * Load the policy and the whole exclusion list for the tx's workspace, in two queries.
   *
   * Loads the exclusions EAGERLY and in full rather than probing per row. The list is a human-maintained
   * deny list — tens of entries, not thousands — so one read beats a query per contact in a 500-row batch by
   * two orders of magnitude, and more importantly it makes the gate a pure function of data already in hand,
   * which is what lets the decision be tested without a database.
   *
   * The exclusions are loaded whether or not the co-op switch is on. They are a restriction the customer wrote
   * down, and a restriction that only binds when some other switch happens to be on is a trap — the admin who
   * saved "never share acme.com" believes it is in force from that moment (D13).
   */
  async resolve(tx: Tx): Promise<ResolvedContributionPolicy> {
    const policyRows = (await tx.execute(
      sql`SELECT contribute_enabled, never_share_fields, revoked_at FROM contribution_policy LIMIT 1`,
    )) as unknown as Array<{
      contribute_enabled: boolean;
      never_share_fields: string[] | null;
      revoked_at: Date | null;
    }>;

    const exclusions = (await tx.execute(
      sql`SELECT kind, domain, account_id, contact_id FROM contribution_exclusion`,
    )) as unknown as Array<{
      kind: string;
      domain: string | null;
      account_id: string | null;
      contact_id: string | null;
    }>;

    const row = policyRows[0];
    const resolved = defaultContributionPolicy();
    // A revoked policy reads as off regardless of the boolean. Revocation is recorded rather than flipping
    // contribute_enabled so the consent history survives (09 rule 5: logged AND revocable) — but a reader
    // that only checked the boolean would keep contributing after a revocation, which is the entire point of
    // revoking. never_share_fields survive revocation: they restrict, so honouring them is never wrong.
    resolved.contributeEnabled = Boolean(row?.contribute_enabled) && !row?.revoked_at;
    resolved.neverShareFields = row?.never_share_fields ?? [];
    for (const e of exclusions) {
      // Lower-cased on the way in so the gate can be a plain Set lookup. The column is citext, so the DB
      // compares case-insensitively too — this keeps the in-memory copy honest to that.
      if (e.kind === "domain" && e.domain) resolved.excludedDomains.add(e.domain.toLowerCase());
      else if (e.kind === "account" && e.account_id) resolved.excludedAccountIds.add(e.account_id);
      else if (e.kind === "contact" && e.contact_id) resolved.excludedContactIds.add(e.contact_id);
    }
    return resolved;
  },

  /** Upsert the workspace's policy. `enabledByUserId` is required to turn it ON — the DB CHECK enforces it too. */
  async upsertPolicy(
    tx: Tx,
    input: {
      tenantId: string;
      workspaceId: string;
      contributeEnabled: boolean;
      neverShareFields?: string[];
      enabledByUserId?: string | null;
    },
  ): Promise<void> {
    // Built as a Postgres array LITERAL and bound as a single parameter, not interpolated into the statement.
    // The values come from a closed enum today, but a parameter cannot become SQL no matter what a future
    // caller passes — and the alternative (sql.raw with hand-escaped quotes) is one refactor away from an
    // injection.
    const fields = input.neverShareFields ?? [];
    const fieldsLiteral = `{${fields.map((f) => `"${f.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
    const on = input.contributeEnabled;
    await tx.execute(
      sql`INSERT INTO contribution_policy
            (workspace_id, tenant_id, contribute_enabled, never_share_fields, enabled_by_user_id, enabled_at, revoked_at)
          VALUES (
            ${input.workspaceId}, ${input.tenantId}, ${on},
            ${fieldsLiteral}::text[],
            ${on ? (input.enabledByUserId ?? null) : null},
            ${on ? sql`now()` : sql`NULL`},
            ${on ? sql`NULL` : sql`now()`}
          )
          ON CONFLICT (workspace_id) DO UPDATE SET
            contribute_enabled = EXCLUDED.contribute_enabled,
            never_share_fields = EXCLUDED.never_share_fields,
            enabled_by_user_id = EXCLUDED.enabled_by_user_id,
            enabled_at         = EXCLUDED.enabled_at,
            -- Turning it back on clears the revocation; turning it off stamps a fresh one. Keeping the old
            -- revoked_at on a re-enable would leave the row permanently reading as revoked, and resolve()
            -- treats revoked_at as authoritative.
            revoked_at         = EXCLUDED.revoked_at,
            updated_at         = now()`,
    );
  },

  /** Add one exclusion. Idempotent per (workspace, target) via the partial uniques. */
  async addExclusion(
    tx: Tx,
    input: {
      tenantId: string;
      workspaceId: string;
      kind: "domain" | "account" | "contact";
      domain?: string | null;
      accountId?: string | null;
      contactId?: string | null;
      note?: string | null;
      createdByUserId?: string | null;
    },
  ): Promise<void> {
    await tx.execute(
      sql`INSERT INTO contribution_exclusion
            (tenant_id, workspace_id, kind, domain, account_id, contact_id, note, created_by_user_id)
          VALUES (${input.tenantId}, ${input.workspaceId}, ${input.kind}, ${input.domain ?? null},
                  ${input.accountId ?? null}, ${input.contactId ?? null}, ${input.note ?? null},
                  ${input.createdByUserId ?? null})
          ON CONFLICT DO NOTHING`,
    );
  },

  /** Remove one exclusion by id. Returns false when it did not exist (or belongs to another workspace). */
  async removeExclusion(tx: Tx, id: string): Promise<boolean> {
    const rows = (await tx.execute(
      sql`DELETE FROM contribution_exclusion WHERE id = ${id} RETURNING id`,
    )) as unknown as Array<{ id: string }>;
    return rows.length > 0;
  },

  async listExclusions(tx: Tx): Promise<
    Array<{
      id: string;
      kind: string;
      domain: string | null;
      accountId: string | null;
      contactId: string | null;
      note: string | null;
      createdAt: Date;
    }>
  > {
    const rows = (await tx.execute(
      sql`SELECT id, kind, domain, account_id, contact_id, note, created_at
            FROM contribution_exclusion ORDER BY created_at DESC`,
    )) as unknown as Array<{
      id: string;
      kind: string;
      domain: string | null;
      account_id: string | null;
      contact_id: string | null;
      note: string | null;
      created_at: Date;
    }>;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      domain: r.domain,
      accountId: r.account_id,
      contactId: r.contact_id,
      note: r.note,
      createdAt: r.created_at,
    }));
  },

  /**
   * Per-object CRM opt-in. Returns the set of object types this connection may contribute — empty when the
   * connection has no rows, which is the state every connection starts in.
   */
  async enabledCrmObjects(tx: Tx, connectionId: string): Promise<Set<string>> {
    const rows = (await tx.execute(
      sql`SELECT object_type FROM crm_object_contribution
           WHERE connection_id = ${connectionId} AND contribute_enabled = true`,
    )) as unknown as Array<{ object_type: string }>;
    return new Set(rows.map((r) => r.object_type));
  },

  async setCrmObjectContribution(
    tx: Tx,
    input: {
      tenantId: string;
      workspaceId: string;
      connectionId: string;
      objectType: string;
      contributeEnabled: boolean;
      enabledByUserId?: string | null;
    },
  ): Promise<void> {
    const on = input.contributeEnabled;
    await tx.execute(
      sql`INSERT INTO crm_object_contribution
            (tenant_id, workspace_id, connection_id, object_type, contribute_enabled, enabled_by_user_id, enabled_at)
          VALUES (${input.tenantId}, ${input.workspaceId}, ${input.connectionId}, ${input.objectType}, ${on},
                  ${on ? (input.enabledByUserId ?? null) : null}, ${on ? sql`now()` : sql`NULL`})
          ON CONFLICT (connection_id, object_type) DO UPDATE SET
            contribute_enabled = EXCLUDED.contribute_enabled,
            enabled_by_user_id = EXCLUDED.enabled_by_user_id,
            enabled_at         = EXCLUDED.enabled_at,
            updated_at         = now()`,
    );
  },
};
