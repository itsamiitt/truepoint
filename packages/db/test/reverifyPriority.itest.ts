// reverifyPriority.itest.ts — the Phase 2 re-verify priority queue (22 §4): worst-first ordering plus the
// composite keyset that makes it safe to page.
//
// Why this needs a real database rather than a unit test: both properties are SQL. The ordering is a
// coalesce() expression, and the paging correctness depends on row-value comparison semantics — `(a, b) > (x,
// y)` — which no mock reproduces. And the failure mode is silent: a broken keyset does not error, it just
// skips contacts, so a sweep would quietly leave records unverified forever while reporting success.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;
let tenantId = "";
let wsId = "";

const CUTOFF = new Date("2026-07-01T00:00:00Z");

/** A revealed contact with an explicit verification age. `verifiedAt: null` = never verified. */
async function makeContact(
  label: string,
  verifiedAt: string | null,
  createdAt: string,
): Promise<string> {
  const [row] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, first_name, email_enc, is_revealed,
                          revealed_by_user_id, revealed_at, last_verified_at, created_at)
    VALUES (${tenantId}, ${wsId}, ${label}, '\\xDEADBEEF'::bytea, true,
            (SELECT id FROM users LIMIT 1), now(), ${verifiedAt}, ${createdAt})
    RETURNING id`;
  return (row as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("reverifyPriority");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES ('acme','acme') RETURNING id`;
  tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('o@acme.test') RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, 'acme', 'acme', true, ${ownerId}) RETURNING id`;
  wsId = (w as { id: string }).id;

  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const page = (cursor: { sortKey: Date; id: string } | null, limit: number) =>
  dbmod.withTenantTx({ tenantId, workspaceId: wsId }, (tx) =>
    dbmod.contactRepository.findStaleRevealedForReverify(tx, CUTOFF, cursor, limit),
  );

describe("re-verify priority ordering", () => {
  test("the most decayed record comes first, and a never-verified one is ranked by how long we have held it", async () => {
    const ancient = await makeContact("Ancient", "2024-01-01T00:00:00Z", "2023-01-01T00:00:00Z");
    const oldNever = await makeContact("OldNever", null, "2024-06-01T00:00:00Z");
    const recentStale = await makeContact(
      "RecentStale",
      "2026-05-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );
    const newNever = await makeContact("NewNever", null, "2026-06-20T00:00:00Z");

    const rows = await page(null, 50);
    const order = rows.map((r) => r.id);

    // Worst first: 2024 verification beats a 2024 never-verified import beats 2026 anything.
    expect(order[0]).toBe(ancient);
    expect(order.indexOf(oldNever)).toBeLessThan(order.indexOf(recentStale));
    // A contact imported LAST MONTH and never verified is not more suspect than one verified two years ago —
    // which is precisely why the sort key falls back to created_at instead of forcing NULLs to one end.
    expect(order.indexOf(newNever)).toBeGreaterThan(order.indexOf(ancient));
    expect(order.indexOf(newNever)).toBeGreaterThan(order.indexOf(oldNever));
  });

  test("a fresh record is not a candidate at all", async () => {
    const fresh = await makeContact("Fresh", "2026-07-30T00:00:00Z", "2026-07-01T00:00:00Z");
    const rows = await page(null, 50);
    expect(rows.map((r) => r.id)).not.toContain(fresh);
  });

  test("paging one row at a time visits every candidate exactly once", async () => {
    // THE assertion. A keyset bug does not error — it silently skips or repeats, so a sweep would leave
    // records unverified forever while reporting success. Walk the whole set in the smallest possible pages,
    // which is the case most likely to expose a boundary error.
    const all = await page(null, 500);
    expect(all.length).toBeGreaterThan(3);

    const seen: string[] = [];
    let cursor: { sortKey: Date; id: string } | null = null;
    for (let i = 0; i < all.length + 5; i++) {
      const batch: Awaited<ReturnType<typeof page>> = await page(cursor, 1);
      if (batch.length === 0) break;
      const row = batch[0] as (typeof batch)[number];
      seen.push(row.id);
      cursor = { sortKey: row.sortKey, id: row.id };
    }

    expect(seen).toEqual(all.map((r) => r.id)); // same rows, same order, no gaps
    expect(new Set(seen).size).toBe(seen.length); // and none repeated
  });

  test("identical timestamps still page correctly — the id breaks the tie", async () => {
    // The realistic trigger: a bulk import stamps thousands of contacts with the SAME last_verified_at. An
    // id-only cursor would skip every row after the first at that timestamp; a sortKey-only cursor would loop
    // on them forever. Only the composite (sortKey, id) is correct.
    const sameTs = "2025-02-02T00:00:00Z";
    for (let i = 0; i < 5; i++) await makeContact(`Tie${i}`, sameTs, "2025-01-01T00:00:00Z");

    const all = await page(null, 500);
    const ties = all.filter((r) => r.sortKey.toISOString() === new Date(sameTs).toISOString());
    expect(ties.length).toBe(5);

    const seen: string[] = [];
    let cursor: { sortKey: Date; id: string } | null = null;
    for (let i = 0; i < all.length + 5; i++) {
      const batch: Awaited<ReturnType<typeof page>> = await page(cursor, 2);
      if (batch.length === 0) break;
      for (const r of batch) seen.push(r.id);
      const last = batch[batch.length - 1] as (typeof batch)[number];
      cursor = { sortKey: last.sortKey, id: last.id };
    }
    for (const t of ties) expect(seen.filter((id) => id === t.id).length).toBe(1);
  });
});
