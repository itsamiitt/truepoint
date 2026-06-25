// trackingIngest.itest.ts — the M12 P3 tracking firehose → timeline projection (email-planning/13 P3, 04).
// Run in its OWN process: `bun test ./packages/db/test/trackingIngest.itest.ts`. Proves ingestTrackingEvent:
//   (1) records an event in email_event AND projects an open into an `email_opened` activity (timeline);
//   (2) is IDEMPOTENT on provider_event_id — a duplicate (MPP/prefetch refire) writes nothing more (D6);
//   (3) projects a click into `email_clicked`;
//   (4) records a `delivery` in email_event but does NOT create a timeline activity.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type IngestMod = typeof import("../../core/src/email/ingestTrackingEvent.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;
let ingestMod: IngestMod;
let tenantA = "";
let wsA = "";
let contactId = "";

async function countEvents(type: string): Promise<number> {
  const [r] =
    await admin`SELECT count(*)::int AS n FROM email_event WHERE workspace_id = ${wsA} AND event_type = ${type}`;
  return (r as { n: number }).n;
}
async function countActivities(type: string): Promise<number> {
  const [r] =
    await admin`SELECT count(*)::int AS n FROM activities WHERE workspace_id = ${wsA} AND activity_type = ${type}`;
  return (r as { n: number }).n;
}

beforeAll(async () => {
  dbHandle = await startItestDb("trackingIngest");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES ('acme','acme') RETURNING id`;
  tenantA = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('owner@acme.test') RETURNING id`;
  const ownerA = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantA}, ${ownerA}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantA}, 'acme', 'acme', true, ${ownerA}) RETURNING id`;
  wsA = (w as { id: string }).id;

  core = await import("../../core/src/index.ts");
  ingestMod = await import("../../core/src/email/ingestTrackingEvent.ts");
  await core.runImport({
    scope: { tenantId: tenantA, workspaceId: wsA },
    sourceName: "manual",
    mapping: { email: "Email", firstName: "First Name", accountDomain: "Domain" },
    rows: [{ Email: "jane@acme.com", "First Name": "Jane", Domain: "acme.com" }],
  });
  const [c] =
    await admin`SELECT id FROM contacts WHERE workspace_id = ${wsA} AND email_domain = 'acme.com'`;
  contactId = (c as { id: string }).id;
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("M12 P3 ingestTrackingEvent", () => {
  const scope = () => ({ tenantId: tenantA, workspaceId: wsA });

  test("an open records an email_event AND projects an email_opened activity", async () => {
    const r = await ingestMod.ingestTrackingEvent(scope(), {
      type: "open",
      contactId,
      providerEventId: "open:log-1",
      isMppSuspected: true,
    });
    expect(r.ingested).toBe(true);
    expect(await countEvents("open")).toBe(1);
    expect(await countActivities("email_opened")).toBe(1);
  });

  test("a duplicate provider event is idempotent — nothing more is written", async () => {
    const r = await ingestMod.ingestTrackingEvent(scope(), {
      type: "open",
      contactId,
      providerEventId: "open:log-1",
    });
    expect(r.ingested).toBe(false);
    expect(await countEvents("open")).toBe(1);
    expect(await countActivities("email_opened")).toBe(1);
  });

  test("a click projects an email_clicked activity", async () => {
    await ingestMod.ingestTrackingEvent(scope(), {
      type: "click",
      contactId,
      providerEventId: "click:log-1:abc",
      metadata: { url: "https://example.com" },
    });
    expect(await countActivities("email_clicked")).toBe(1);
  });

  test("a delivery is recorded but is NOT projected as a timeline activity", async () => {
    const before = await countActivities("email_opened");
    await ingestMod.ingestTrackingEvent(scope(), {
      type: "delivery",
      contactId,
      providerEventId: "delivery:log-1",
    });
    expect(await countEvents("delivery")).toBe(1);
    expect(await countActivities("email_opened")).toBe(before); // unchanged
  });
});
