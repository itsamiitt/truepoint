// crmSyncPersistence.itest.ts — the idempotency + watermark invariants the sync runners will rely on
// (crm-sync 00 §4.2 / §4.4 / §4.5 / §4.6). Real Postgres 16; run in its OWN process:
//   bun test ./packages/db/test/crmSyncPersistence.itest.ts
//
// These are the properties that decide whether a two-way sync converges or corrupts:
//   - crm_record_links: the same CRM record seen twice converges on ONE row; a Lead->Contact conversion
//     re-points that row rather than minting a second; inbound and outbound touches write disjoint fields.
//   - crm_sync_state: the watermark advances MONOTONICALLY — a late-finishing job for an older window
//     cannot rewind it, which is the difference between a stable poll and an endless re-pull.
//   - crm_inbound_events: a redelivered provider event appends once and reports isNew=false.
//   - crm_sync_runs: counters accumulate RELATIVELY, so pages and retries sum instead of clobbering.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, one, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

let tenantA = "";
let wsA = "";
let ownerA = "";
let connectionA = "";
let contact1 = "";
let contact2 = "";

const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });

beforeAll(async () => {
  dbHandle = await startItestDb("crmSyncPersistence");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  dbmod = await import("@leadwolf/db");

  const t = one<{ id: string }>(
    await admin`INSERT INTO tenants (name, slug) VALUES ('acme','acme') RETURNING id`,
    "tenant",
  );
  tenantA = t.id;
  const u = one<{ id: string }>(
    await admin`INSERT INTO users (email) VALUES ('owner@acme.test') RETURNING id`,
    "user",
  );
  ownerA = u.id;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner)
    VALUES (${tenantA}, ${ownerA}, true)`;
  const w = one<{ id: string }>(
    await admin`
      INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
      VALUES (${tenantA}, 'acme', 'acme', true, ${ownerA}) RETURNING id`,
    "workspace",
  );
  wsA = w.id;

  const c = one<{ id: string }>(
    await admin`
      INSERT INTO crm_connections (tenant_id, workspace_id, provider, status, external_account_id)
      VALUES (${tenantA}, ${wsA}, 'salesforce', 'connected', 'ORG-PERSIST') RETURNING id`,
    "connection",
  );
  connectionA = c.id;

  contact1 = one<{ id: string }>(
    await admin`
      INSERT INTO contacts (tenant_id, workspace_id, first_name) VALUES (${tenantA}, ${wsA}, 'One')
      RETURNING id`,
    "contact",
  ).id;
  contact2 = one<{ id: string }>(
    await admin`
      INSERT INTO contacts (tenant_id, workspace_id, first_name) VALUES (${tenantA}, ${wsA}, 'Two')
      RETURNING id`,
    "contact",
  ).id;
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("crm_record_links — the durable idempotency wall", () => {
  test("the same CRM record upserted twice converges on ONE row", async () => {
    const base = {
      tenantId: tenantA,
      workspaceId: wsA,
      connectionId: connectionA,
      tpEntityType: "contact" as const,
      contactId: contact1,
      crmObjectType: "Contact",
      crmRecordId: "SFDC-0031",
    };
    const first = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmRecordLinkRepository.upsertByCrmRecord(tx, base),
    );
    const second = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmRecordLinkRepository.upsertByCrmRecord(tx, {
        ...base,
        lastInboundModstamp: new Date(Date.parse("2026-06-01T00:00:00Z")),
      }),
    );
    expect(second).toBe(first);

    const n = one<{ n: number }>(
      await admin`
        SELECT count(*)::int AS n FROM crm_record_links
        WHERE connection_id = ${connectionA} AND crm_record_id = 'SFDC-0031'`,
      "count",
    );
    expect(n.n).toBe(1);
  });

  test("an outbound push does NOT clear the inbound watermark (the two directions are disjoint)", async () => {
    const linkId = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmRecordLinkRepository.upsertByCrmRecord(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        connectionId: connectionA,
        tpEntityType: "contact",
        contactId: contact2,
        crmObjectType: "Contact",
        crmRecordId: "SFDC-0032",
        lastInboundModstamp: new Date(Date.parse("2026-06-10T00:00:00Z")),
      }),
    );

    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmRecordLinkRepository.markPushed(tx, linkId, new Uint8Array([1, 2, 3])),
    );

    const link = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmRecordLinkRepository.findByCrmRecord(tx, connectionA, "Contact", "SFDC-0032"),
    );
    expect(link?.lastInboundModstamp?.toISOString()).toBe("2026-06-10T00:00:00.000Z");
    expect(link?.lastOutboundAt).not.toBeNull();
    expect(link?.lastSyncedHash).not.toBeNull();
  });

  test("an upsert with NO modstamp does not blank an existing one", async () => {
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmRecordLinkRepository.upsertByCrmRecord(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        connectionId: connectionA,
        tpEntityType: "contact",
        contactId: contact2,
        crmObjectType: "Contact",
        crmRecordId: "SFDC-0032",
      }),
    );
    const link = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmRecordLinkRepository.findByCrmRecord(tx, connectionA, "Contact", "SFDC-0032"),
    );
    expect(link?.lastInboundModstamp?.toISOString()).toBe("2026-06-10T00:00:00.000Z");
  });

  test("Lead -> Contact conversion RE-POINTS the row: no second link, no orphan", async () => {
    // The tricky SFDC case. Creating a new link would violate uniq_crm_record_links_contact (the TP contact
    // already has one under this connection) and leave a dangling Lead link behind.
    const leadLink = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmRecordLinkRepository.upsertByCrmRecord(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        connectionId: connectionA,
        tpEntityType: "contact",
        contactId: contact1,
        crmObjectType: "Lead",
        crmRecordId: "SFDC-LEAD-1",
      }),
    );
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmRecordLinkRepository.repointToConvertedRecord(
        tx,
        leadLink,
        "Contact",
        "SFDC-CONV-1",
      ),
    );

    const moved = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmRecordLinkRepository.findByCrmRecord(tx, connectionA, "Contact", "SFDC-CONV-1"),
    );
    expect(moved?.id).toBe(leadLink);

    const oldGone = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmRecordLinkRepository.findByCrmRecord(tx, connectionA, "Lead", "SFDC-LEAD-1"),
    );
    expect(oldGone).toBeNull();
  });

  test("one contact cannot hold two links under the same connection", async () => {
    let blocked = false;
    try {
      await dbmod.withTenantTx(scopeA(), (tx) =>
        dbmod.crmRecordLinkRepository.upsertByCrmRecord(tx, {
          tenantId: tenantA,
          workspaceId: wsA,
          connectionId: connectionA,
          tpEntityType: "contact",
          contactId: contact1, // already linked to SFDC-CONV-1
          crmObjectType: "Contact",
          crmRecordId: "SFDC-OTHER",
        }),
      );
    } catch {
      blocked = true;
    }
    // uniq_crm_record_links_contact is a real INSERT conflict on a DIFFERENT index than the upsert target,
    // so it raises rather than being absorbed — which is correct: a contact mapping to two CRM records is
    // an ambiguity for review, not something to silently overwrite.
    expect(blocked).toBe(true);
  });
});

describe("crm_sync_state — the monotonic watermark", () => {
  let stateId = "";

  test("getOrCreate is idempotent for the same (connection, object, direction)", async () => {
    const a = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncStateRepository.getOrCreate(tx, scopeA(), connectionA, "contact", "inbound"),
    );
    const b = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncStateRepository.getOrCreate(tx, scopeA(), connectionA, "contact", "inbound"),
    );
    expect(b.id).toBe(a.id);
    stateId = a.id;
    expect(a.watermark).toBeNull();
    expect(a.backfillStatus).toBe("pending");
  });

  test("inbound and outbound are SEPARATE streams (loop prevention)", async () => {
    const out = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncStateRepository.getOrCreate(tx, scopeA(), connectionA, "contact", "outbound"),
    );
    expect(out.id).not.toBe(stateId);
  });

  test("the watermark advances forward", async () => {
    const t1 = new Date(Date.parse("2026-06-01T00:00:00Z"));
    const got = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncStateRepository.advanceWatermark(tx, stateId, t1),
    );
    expect(got?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  test("a LATE job for an OLDER window cannot rewind it", async () => {
    // The failure this prevents: a retried job finishing after a newer one, rewinding the cursor, and
    // causing every record since to be re-pulled on the next tick — forever, on a busy workspace.
    const older = new Date(Date.parse("2026-01-01T00:00:00Z"));
    const got = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncStateRepository.advanceWatermark(tx, stateId, older),
    );
    expect(got?.toISOString()).toBe("2026-06-01T00:00:00.000Z"); // unchanged
  });

  test("a newer candidate does move it", async () => {
    const newer = new Date(Date.parse("2026-07-01T00:00:00Z"));
    const got = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncStateRepository.advanceWatermark(tx, stateId, newer),
    );
    expect(got?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  test("concurrent advances converge on the MAXIMUM, not the last writer", async () => {
    const s = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncStateRepository.getOrCreate(tx, scopeA(), connectionA, "account", "inbound"),
    );
    await Promise.all([
      dbmod.withTenantTx(scopeA(), (tx) =>
        dbmod.crmSyncStateRepository.advanceWatermark(
          tx,
          s.id,
          new Date(Date.parse("2026-03-01T00:00:00Z")),
        ),
      ),
      dbmod.withTenantTx(scopeA(), (tx) =>
        dbmod.crmSyncStateRepository.advanceWatermark(
          tx,
          s.id,
          new Date(Date.parse("2026-09-01T00:00:00Z")),
        ),
      ),
    ]);
    const after = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncStateRepository.readWithOverlap(tx, s.id, 0),
    );
    expect(after.watermark?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  test("readWithOverlap subtracts the overlap window, and reports null before any watermark", async () => {
    const fresh = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncStateRepository.getOrCreate(tx, scopeA(), connectionA, "lead", "inbound"),
    );
    const none = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncStateRepository.readWithOverlap(tx, fresh.id, 60_000),
    );
    // No watermark yet → the caller must backfill, not pull "since the epoch".
    expect(none.since).toBeNull();

    const withMark = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncStateRepository.readWithOverlap(tx, stateId, 60_000),
    );
    expect(withMark.watermark?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(withMark.since?.toISOString()).toBe("2026-06-30T23:59:00.000Z");
  });
});

describe("crm_inbound_events — the redelivery wall", () => {
  test("a redelivered provider event appends once and reports isNew=false", async () => {
    const evt = {
      tenantId: tenantA,
      workspaceId: wsA,
      connectionId: connectionA,
      provider: "salesforce",
      objectType: "contact",
      crmObjectType: "Contact",
      crmRecordId: "SFDC-0031",
      providerEventId: "SFDC-0031:replay-42",
    };
    const first = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmInboundEventRepository.append(tx, evt),
    );
    expect(first.isNew).toBe(true);

    const again = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmInboundEventRepository.append(tx, evt),
    );
    expect(again.isNew).toBe(false);
    expect(again.id).toBe(first.id); // the SAME row, so the caller can correlate

    const n = one<{ n: number }>(
      await admin`
        SELECT count(*)::int AS n FROM crm_inbound_events
        WHERE connection_id = ${connectionA} AND provider_event_id = 'SFDC-0031:replay-42'`,
      "count",
    );
    expect(n.n).toBe(1);
  });

  test("a different event id for the same record is NOT deduped", async () => {
    const r = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmInboundEventRepository.append(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        connectionId: connectionA,
        provider: "salesforce",
        objectType: "contact",
        crmObjectType: "Contact",
        crmRecordId: "SFDC-0031",
        providerEventId: "SFDC-0031:replay-43", // a genuinely later change to the same record
      }),
    );
    expect(r.isNew).toBe(true);
  });
});

describe("crm_sync_runs — the durable run ledger", () => {
  test("counters accumulate relatively, so pages and retries sum instead of clobbering", async () => {
    const runId = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncRunRepository.start(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        connectionId: connectionA,
        provider: "salesforce",
        objectType: "contact",
        direction: "inbound",
        trigger: "scheduled",
        mode: "shadow",
      }),
    );

    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncRunRepository.addCounts(tx, runId, { recordsSeen: 100, recordsCreated: 10 }),
    );
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncRunRepository.addCounts(tx, runId, { recordsSeen: 50, recordsUpdated: 7 }),
    );

    const row = one<{
      records_seen: number;
      records_created: number;
      records_updated: number;
      status: string;
      mode: string;
    }>(
      await admin`
        SELECT records_seen, records_created, records_updated, status, mode
        FROM crm_sync_runs WHERE id = ${runId}`,
      "run",
    );
    expect(row.records_seen).toBe(150);
    expect(row.records_created).toBe(10);
    expect(row.records_updated).toBe(7);
    expect(row.status).toBe("running");
    // The mode snapshot is what makes a shadow run auditable as "counted but did not write".
    expect(row.mode).toBe("shadow");
  });

  test("finish closes the run and records a PII-free reason", async () => {
    const runId = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncRunRepository.start(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        connectionId: connectionA,
        provider: "salesforce",
        objectType: "contact",
        direction: "outbound",
        trigger: "manual",
        mode: "enforce",
      }),
    );
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncRunRepository.finish(tx, runId, "partial", {
        failedReason: "REQUEST_LIMIT_EXCEEDED",
        watermarkAfter: new Date(Date.parse("2026-07-02T00:00:00Z")),
      }),
    );
    const row = one<{ status: string; failed_reason: string; finished_at: Date | null }>(
      await admin`SELECT status, failed_reason, finished_at FROM crm_sync_runs WHERE id = ${runId}`,
      "run",
    );
    expect(row.status).toBe("partial");
    expect(row.failed_reason).toBe("REQUEST_LIMIT_EXCEEDED");
    expect(row.finished_at).not.toBeNull();
  });

  test("listRecentForConnection returns newest-first", async () => {
    const rows = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmSyncRunRepository.listRecentForConnection(tx, connectionA, 10),
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.startedAt.getTime()).toBeGreaterThanOrEqual(rows[i]!.startedAt.getTime());
    }
  });
});
