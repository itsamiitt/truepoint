// emailAnalytics.itest.ts — the M12 P5 deliverability aggregation (email-planning/13 P5, 08). Run in its OWN
// process. Seeds email_event + an email_replied activity and asserts computeDeliverability's counts + rates
// (reply rate primary, D6). Workspace-scoped via RLS.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;
let tenantA = "";
let wsA = "";

async function seedEvent(type: string, providerEventId: string): Promise<void> {
  await admin`
    INSERT INTO email_event (tenant_id, workspace_id, event_type, provider_event_id, occurred_at)
    VALUES (${tenantA}, ${wsA}, ${type}, ${providerEventId}, now())`;
}

beforeAll(async () => {
  dbHandle = await startItestDb("emailAnalytics");
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
  const [c] =
    await admin`INSERT INTO contacts (tenant_id, workspace_id) VALUES (${tenantA}, ${wsA}) RETURNING id`;
  const contactId = (c as { id: string }).id;

  core = await import("../../core/src/index.ts");

  // 10 delivered, 4 opened, 2 clicked, 1 bounced.
  for (let i = 0; i < 10; i++) await seedEvent("delivery", `del-${i}`);
  for (let i = 0; i < 4; i++) await seedEvent("open", `open-${i}`);
  for (let i = 0; i < 2; i++) await seedEvent("click", `click-${i}`);
  await seedEvent("bounce", "bounce-0");
  // 2 replies (the primary KPI) via the activity stream.
  for (let i = 0; i < 2; i++) {
    await admin`
      INSERT INTO activities (tenant_id, workspace_id, contact_id, activity_type, channel, occurred_at)
      VALUES (${tenantA}, ${wsA}, ${contactId}, 'email_replied', 'email', now())`;
  }
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("M12 P5 computeDeliverability", () => {
  test("aggregates counts and rates (reply rate primary, D6)", async () => {
    const r = await core.computeDeliverability({ tenantId: tenantA, workspaceId: wsA }, 30);
    expect(r.delivered).toBe(10);
    expect(r.opened).toBe(4);
    expect(r.clicked).toBe(2);
    expect(r.bounced).toBe(1);
    expect(r.replied).toBe(2);
    expect(r.sent).toBe(11); // delivered + bounced

    expect(r.replyRate).toBe(20); // 2 / 10 delivered
    expect(r.openRate).toBe(40); // 4 / 10
    expect(r.clickRate).toBe(20); // 2 / 10
    expect(r.bounceRate).toBe(9.1); // 1 / 11, one decimal
  });
});
