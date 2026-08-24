// eventOutboxRetention.itest.ts — the outbox prune deletes the right rows, and ONLY those.
//
// `event_outbox` had no retention of any kind. `prunePublished` existed, documented as "retention", and had
// no caller anywhere — found by auditing repository methods for call sites — while emitRevealEvent and
// linkedinLinkFetchSweep kept appending and the relay only ever flipped rows to `published`. Rows have been
// accumulating for the lifetime of the table.
//
// The direction that matters here is NOT "does it delete". A retention DELETE that removes too much is far
// worse than one that removes too little: the too-little case is a disk-space bug, the too-much case destroys
// events that have not been published yet. So every test below pins something the prune must LEAVE ALONE.
//
// Run in its own process (the db client is a module singleton):
//   bun test ./packages/db/test/eventOutboxRetention.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

let tenantId = "";
let workspaceId = "";

/** Insert a row directly, so age and status are exactly what each case needs. */
async function seedEvent(opts: {
  status: "pending" | "published" | "failed";
  publishedDaysAgo?: number;
  eventType?: string;
}): Promise<string> {
  const publishedAt =
    opts.publishedDaysAgo === undefined
      ? null
      : new Date(Date.now() - opts.publishedDaysAgo * 24 * 60 * 60_000);
  // payload omitted deliberately — the column defaults to '{}', so this avoids depending on a driver JSON
  // helper for a value no assertion here reads.
  const [row] = await admin`
    INSERT INTO event_outbox (tenant_id, workspace_id, event_type, status, published_at)
    VALUES (${tenantId}, ${workspaceId}, ${opts.eventType ?? "reveal.completed"},
            ${opts.status}, ${publishedAt})
    RETURNING id`;
  return (row as { id: string }).id;
}

async function exists(id: string): Promise<boolean> {
  const rows = await admin`SELECT 1 FROM event_outbox WHERE id = ${id}`;
  return rows.length > 0;
}

beforeAll(async () => {
  dbHandle = await startItestDb("eventOutboxRetention");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  const [t] =
    await admin`INSERT INTO tenants (name, slug) VALUES ('outbox', 'outbox') RETURNING id`;
  tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('owner@outbox.test') RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner)
              VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, 'outbox', 'outbox', true, ${ownerId}) RETURNING id`;
  workspaceId = (w as { id: string }).id;

  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("event_outbox retention", () => {
  test("prunes published rows older than the cutoff, and leaves everything else", async () => {
    const oldPublished = await seedEvent({ status: "published", publishedDaysAgo: 30 });
    const recentPublished = await seedEvent({ status: "published", publishedDaysAgo: 1 });
    const pending = await seedEvent({ status: "pending" });
    const failed = await seedEvent({ status: "failed" });

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000);
    const deleted = await dbmod.withPrivilegedTx((tx) =>
      dbmod.eventOutboxRepository.prunePublished(tx, cutoff, 5000),
    );

    expect(deleted).toBe(1);
    expect(await exists(oldPublished)).toBe(false);
    // Everything below is what the prune must NOT touch. A pending row is an event the relay has not
    // published yet — deleting one loses it outright, with no retry and no trace.
    expect(await exists(recentPublished)).toBe(true);
    expect(await exists(pending)).toBe(true);
    expect(await exists(failed)).toBe(true);
  });

  test("a pending row with a NULL published_at is never swept, however old the cutoff", async () => {
    // published_at is NULL until the relay publishes. `NULL < timestamp` is NULL, not true, so SQL's
    // three-valued logic already excludes these — this pins that, because a later rewrite using
    // COALESCE(published_at, occurred_at) would silently start deleting unpublished events.
    const pending = await seedEvent({ status: "pending" });
    const far = new Date(Date.now() + 365 * 24 * 60 * 60_000); // cutoff in the future: matches everything datable
    await dbmod.withPrivilegedTx((tx) => dbmod.eventOutboxRepository.prunePublished(tx, far, 5000));
    // The count is not asserted: this cutoff also sweeps rows the previous test left behind, so any number
    // would be incidental. The claim being made is only that the unpublished row survived a prune whose
    // window covers everything that HAS a published_at.
    expect(await exists(pending)).toBe(true);
  });

  test("honours the batch limit, so the caller drains rather than locking the whole backlog", async () => {
    for (let i = 0; i < 5; i += 1) await seedEvent({ status: "published", publishedDaysAgo: 30 });

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000);
    const first = await dbmod.withPrivilegedTx((tx) =>
      dbmod.eventOutboxRepository.prunePublished(tx, cutoff, 2),
    );
    expect(first).toBe(2); // bounded by the limit, not by how many matched

    // The caller's loop shape: keep going until a short batch comes back.
    let drained = first;
    for (;;) {
      const n = await dbmod.withPrivilegedTx((tx) =>
        dbmod.eventOutboxRepository.prunePublished(tx, cutoff, 2),
      );
      drained += n;
      if (n < 2) break;
    }
    expect(drained).toBe(5);
  });
});
