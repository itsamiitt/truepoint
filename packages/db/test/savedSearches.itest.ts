// savedSearches.itest.ts — the M8 saved-searches / segments Definition-of-Done proof on a real Postgres 16
// (24 §8, ADR-0035): Testcontainers by default, or an external server via ITEST_DATABASE_URL (see itestDb.ts).
// Run in its OWN process (the db client is a module singleton):
//   `bun test ./packages/db/test/savedSearches.itest.ts`
//
// Proves (the unit's acceptance criteria):
//   (1) save a validated filter set → it lists → the persisted `filters` blob round-trips unchanged through
//       `contactQuery`, so applying it = re-running POST /search/contacts with the same query;
//   (2) invalid filters are REJECTED on save (422 validation_error) and nothing is written;
//   (3) visibility is honoured: a private search is invisible to a co-worker in the SAME workspace; a
//       workspace-visible one is visible to them; mutations (rename/delete) are OWNER-gated (a co-worker's
//       attempt 404s and leaves the row intact);
//   (4) per-workspace RLS ISOLATION: under the non-BYPASSRLS leadwolf_app role (withTenantTx), workspace B
//       can never see, rename, or delete workspace A's saved searches — even workspace-visible ones.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type Types = typeof import("@leadwolf/types");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;
let types: Types;

// Two tenants × one workspace each (RLS isolation), plus a second user in tenant A's workspace (visibility).
let tenantA = "";
let wsA = "";
let ownerA = ""; // creates the saved searches in A
let coworkerA = ""; // a second member of wsA — used for the visibility + owner-gating proofs
let tenantB = "";
let wsB = "";
let ownerB = "";

async function seedUser(email: string): Promise<string> {
  const [u] = await admin`INSERT INTO users (email) VALUES (${email}) RETURNING id`;
  return (u as { id: string }).id;
}

async function seedTenantWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const ownerId = await seedUser(`owner@${slug}.test`);
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  return { tenantId, workspaceId: (w as { id: string }).id, ownerId };
}

/** Run a rejecting call once and hand back the error (typed loosely for code/message assertions). */
async function caught(run: () => Promise<unknown>): Promise<{ code?: string } & Error> {
  try {
    await run();
    throw new Error("expected the call to reject, but it resolved");
  } catch (err) {
    return err as { code?: string } & Error;
  }
}

async function rowCount(workspaceId: string): Promise<number> {
  const [r] = await admin`
    SELECT count(*)::int AS n FROM saved_searches WHERE workspace_id = ${workspaceId}`;
  return (r as { n: number }).n;
}

beforeAll(async () => {
  dbHandle = await startItestDb("savedSearches");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedTenantWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB, ownerId: ownerB } = await seedTenantWorkspace("globex"));
  coworkerA = await seedUser("coworker@acme.test");
  await admin`
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES (${wsA}, ${coworkerA}, 'member', 'active', now())`;

  // env set above, BEFORE these dynamic imports load @leadwolf/config / the db singleton.
  core = await import("../../core/src/index.ts");
  types = await import("@leadwolf/types");
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });

// A realistic filter set the prospect rail would produce (term + range — search.ts FilterClause union).
const FILTERS = {
  text: "growth",
  filters: [
    { kind: "term", field: "seniority", op: "include", values: ["vp", "director"] },
    { kind: "range", field: "employee_count", gte: 50, lte: 500 },
  ],
  sort: "score_desc",
  limit: 25,
} as const;

describe("M8 saved searches / segments DoD", () => {
  test("save a validated filter set → it lists → the blob round-trips unchanged (re-applicable)", async () => {
    const saved = await core.createSavedSearch({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "VP+ growth (50–500)",
      filters: FILTERS,
      visibility: "private",
    });
    expect(saved.id).toBeTruthy();
    expect(saved.isOwner).toBe(true);

    const list = await core.listSavedSearches({ scope: scopeA(), callerUserId: ownerA });
    const found = list.find((s) => s.id === saved.id);
    expect(found).toBeDefined();

    // The persisted filters are exactly a valid contactQuery (so re-running POST /search/contacts works) and
    // carry every clause back — the normalized defaults (filters[].op already present) round-trip too.
    const reparsed = types.contactQuery.safeParse(found?.filters);
    expect(reparsed.success).toBe(true);
    expect(found?.filters.text).toBe("growth");
    expect(found?.filters.sort).toBe("score_desc");
    expect(found?.filters.limit).toBe(25);
    expect(found?.filters.filters).toHaveLength(2);
  });

  test("invalid filters are rejected on save and nothing is written", async () => {
    const before = await rowCount(wsA);
    const err = await caught(() =>
      core.createSavedSearch({
        scope: scopeA(),
        callerUserId: ownerA,
        name: "broken",
        // `field` is not a FacetKey and a term needs non-empty `values` → contactQuery rejects it.
        filters: { filters: [{ kind: "term", field: "not_a_facet", values: [] }] },
        visibility: "private",
      }),
    );
    expect(err.code).toBe("validation_error");
    expect(await rowCount(wsA)).toBe(before); // no partial write
  });

  test("visibility is honoured + mutations are owner-gated within a workspace", async () => {
    const priv = await core.createSavedSearch({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "owner private",
      filters: FILTERS,
      visibility: "private",
    });
    const shared = await core.createSavedSearch({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "owner shared",
      filters: FILTERS,
      visibility: "workspace",
    });

    // The co-worker (same workspace) sees the workspace-visible row but NOT the owner's private row.
    const coworkerList = await core.listSavedSearches({ scope: scopeA(), callerUserId: coworkerA });
    const coworkerIds = coworkerList.map((s) => s.id);
    expect(coworkerIds).toContain(shared.id);
    expect(coworkerIds).not.toContain(priv.id);
    // isOwner is stamped per-caller: the co-worker doesn't own the shared row.
    expect(coworkerList.find((s) => s.id === shared.id)?.isOwner).toBe(false);

    // The co-worker cannot rename or delete the owner's shared search (owner-gated → 404, no existence leak).
    const renameErr = await caught(() =>
      core.updateSavedSearch({
        scope: scopeA(),
        callerUserId: coworkerA,
        id: shared.id,
        name: "hijacked",
      }),
    );
    expect(renameErr.code).toBe("not_found");
    const delErr = await caught(() =>
      core.deleteSavedSearch({ scope: scopeA(), callerUserId: coworkerA, id: shared.id }),
    );
    expect(delErr.code).toBe("not_found");

    // The shared row survived both attempts, unchanged.
    const [r] = await admin`SELECT name FROM saved_searches WHERE id = ${shared.id}`;
    expect((r as { name: string }).name).toBe("owner shared");

    // The owner CAN rename + delete their own rows.
    const renamed = await core.updateSavedSearch({
      scope: scopeA(),
      callerUserId: ownerA,
      id: shared.id,
      name: "owner shared (v2)",
    });
    expect(renamed.name).toBe("owner shared (v2)");
    await core.deleteSavedSearch({ scope: scopeA(), callerUserId: ownerA, id: priv.id });
    const [gone] = await admin`SELECT count(*)::int AS n FROM saved_searches WHERE id = ${priv.id}`;
    expect((gone as { n: number }).n).toBe(0);
  });

  test("per-workspace RLS isolation: workspace B never sees/mutates workspace A's saved searches", async () => {
    // Seed one of EACH visibility in A.
    const aPrivate = await core.createSavedSearch({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "A private",
      filters: FILTERS,
      visibility: "private",
    });
    const aShared = await core.createSavedSearch({
      scope: scopeA(),
      callerUserId: ownerA,
      name: "A shared",
      filters: FILTERS,
      visibility: "workspace",
    });

    // B lists under withTenantTx (SET LOCAL ROLE leadwolf_app + B's GUCs) → sees NONE of A's rows.
    const bList = await core.listSavedSearches({ scope: scopeB(), callerUserId: ownerB });
    const bIds = bList.map((s) => s.id);
    expect(bIds).not.toContain(aPrivate.id);
    expect(bIds).not.toContain(aShared.id);

    // B cannot rename or delete A's rows even guessing the ids — RLS hides the rows, so it's a 404.
    const xErr = await caught(() =>
      core.updateSavedSearch({
        scope: scopeB(),
        callerUserId: ownerB,
        id: aShared.id,
        name: "stolen",
      }),
    );
    expect(xErr.code).toBe("not_found");
    const xDel = await caught(() =>
      core.deleteSavedSearch({ scope: scopeB(), callerUserId: ownerB, id: aShared.id }),
    );
    expect(xDel.code).toBe("not_found");

    // A's rows are untouched (verified with the BYPASSRLS admin connection).
    const [stillA] = await admin`
      SELECT count(*)::int AS n FROM saved_searches WHERE id IN (${aPrivate.id}, ${aShared.id})`;
    expect((stillA as { n: number }).n).toBe(2);
  });
});
