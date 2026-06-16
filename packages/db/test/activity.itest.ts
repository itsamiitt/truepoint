// activity.itest.ts — the M7+M8 Definition-of-Done proof on a real Postgres 16 (10/14 §3.5): Testcontainers
// by default, or an external server via ITEST_DATABASE_URL (see itestDb.ts). Run in its OWN process (the db
// client is a module singleton): `bun test ./packages/db/test/activity.itest.ts`.
//
// Proves: (1) logged activities read back newest-first and the trigger keeps contacts.last_activity_at at
// the newest occurred_at; (2) an older backfilled activity never regresses last_activity_at; (3) the M8
// engagement component scores the reply and the composite reflects it (scores append per re-score); (4) RLS
// hides activities from a wrong-workspace leadwolf_app session; (5) sales_nav_links dedups on
// (workspace_id, url) — the second insert of the same link is rejected.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");

let dbHandle: ItestDb;
let core: Core;
let admin: ReturnType<typeof postgres>;
let appUrl = "";
let tenantA = "";
let wsA = "";
let ownerA = "";

// The barrels are wired at integration; until then these symbols load via their direct module paths.
// (Type aliases keep each `typeof import` on one line — Bun's transpiler rejects the wrapped form.)
type DbModule = typeof import("@leadwolf/db");
type LogActivityModule = typeof import("../../core/src/activity/logActivity.ts");
type ActivityRepoModule = typeof import("../src/repositories/activityRepository.ts");
type SalesNavRepoModule = typeof import("../src/repositories/salesNavLinkRepository.ts");
let withTenantTx: DbModule["withTenantTx"];
let logActivity: LogActivityModule["logActivity"];
let activityRepository: ActivityRepoModule["activityRepository"];
let salesNavLinkRepository: SalesNavRepoModule["salesNavLinkRepository"];

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  lastName: "Last Name",
  accountName: "Company",
  accountDomain: "Domain",
};
const ROWS = [
  {
    Email: "jane@acme.com",
    "First Name": "Jane",
    "Last Name": "Doe",
    Company: "Acme",
    Domain: "acme.com",
  },
  {
    Email: "mark@globex.com",
    "First Name": "Mark",
    "Last Name": "Roe",
    Company: "Globex",
    Domain: "globex.com",
  },
  {
    Email: "lena@initech.com",
    "First Name": "Lena",
    "Last Name": "Lee",
    Company: "Initech",
    Domain: "initech.com",
  },
];

// Relative-to-now timestamps keep every activity inside the scorer's 30-day engagement window.
const DAY = 86_400_000;
const tCall = new Date(Date.now() - 3 * DAY);
const tReply = new Date(Date.now() - 1 * DAY); // the newest — last_activity_at must land here
const tBackfill = new Date(Date.now() - 10 * DAY); // older than both — must never regress it

async function contactIdByDomain(workspaceId: string, emailDomain: string): Promise<string> {
  const [r] = await admin`
    SELECT id FROM contacts WHERE workspace_id = ${workspaceId} AND email_domain = ${emailDomain}`;
  return (r as { id: string }).id;
}

async function lastActivityAt(contactId: string): Promise<number> {
  const [c] = await admin`SELECT last_activity_at FROM contacts WHERE id = ${contactId}`;
  return new Date((c as { last_activity_at: Date }).last_activity_at).getTime();
}

beforeAll(async () => {
  dbHandle = await startItestDb("activity");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  appUrl = dbHandle.appUrl;

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  const [t] =
    await admin`INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES ('acme','acme',10) RETURNING id`;
  tenantA = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('owner@acme.test') RETURNING id`;
  ownerA = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantA}, ${ownerA}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantA}, 'acme', 'acme', true, ${ownerA}) RETURNING id`;
  wsA = (w as { id: string }).id;

  core = await import("../../core/src/index.ts");
  ({ withTenantTx } = await import("@leadwolf/db"));
  ({ logActivity } = await import("../../core/src/activity/logActivity.ts"));
  ({ activityRepository } = await import("../src/repositories/activityRepository.ts"));
  ({ salesNavLinkRepository } = await import("../src/repositories/salesNavLinkRepository.ts"));

  await core.runImport({
    scope: { tenantId: tenantA, workspaceId: wsA },
    sourceName: "manual",
    mapping: MAPPING,
    rows: ROWS,
  });
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("M7+M8 activity timeline, engagement scoring & Sales Nav links DoD", () => {
  test("logged activities read newest-first and the trigger advances last_activity_at", async () => {
    const contactId = await contactIdByDomain(wsA, "acme.com");
    const scope = { tenantId: tenantA, workspaceId: wsA };

    const callId = await logActivity({
      scope,
      contactId,
      actorUserId: ownerA,
      activityType: "call_made",
      channel: "phone",
      outcome: "no_answer",
      note: "Left a voicemail",
      occurredAt: tCall,
    });
    const replyId = await logActivity({
      scope,
      contactId,
      actorUserId: ownerA,
      activityType: "email_replied",
      channel: "email",
      outcome: "positive",
      occurredAt: tReply,
    });
    expect(callId).not.toBe(replyId);

    const timeline = await activityRepository.timelineForContact(scope, contactId);
    expect(timeline.map((a) => a.activityType)).toEqual(["email_replied", "call_made"]);
    expect(timeline[0]?.actorUserId).toBe(ownerA);
    expect(timeline[1]?.note).toBe("Left a voicemail");

    expect(await lastActivityAt(contactId)).toBe(tReply.getTime());
  });

  test("an older backfilled activity never regresses last_activity_at", async () => {
    const contactId = await contactIdByDomain(wsA, "acme.com");
    const scope = { tenantId: tenantA, workspaceId: wsA };

    await logActivity({
      scope,
      contactId,
      activityType: "note_added",
      channel: "in-person",
      note: "Backfilled conference note",
      occurredAt: tBackfill,
    });

    expect(await lastActivityAt(contactId)).toBe(tReply.getTime()); // unchanged
    const timeline = await activityRepository.timelineForContact(scope, contactId);
    expect(timeline.map((a) => a.activityType)).toEqual([
      "email_replied",
      "call_made",
      "note_added",
    ]);
  });

  test("the M8 engagement component scores the reply and the composite reflects it", async () => {
    const contactId = await contactIdByDomain(wsA, "acme.com");
    const scope = { tenantId: tenantA, workspaceId: wsA };

    const first = await core.computeScore({ scope, contactId });
    expect(first.engagementScore).toBeGreaterThan(0);
    expect(first.engagementScore).toBe(30); // one email_replied ×30; call_made/note_added score 0
    expect(first.compositeScore).toBe(
      Math.round(first.icpFit * 0.5 + first.intentScore * 0.3 + first.engagementScore * 0.2),
    );

    const second = await core.computeScore({ scope, contactId });
    expect(second.engagementScore).toBe(30);
    const [n] = await admin`SELECT count(*)::int AS n FROM scores WHERE contact_id = ${contactId}`;
    expect((n as { n: number }).n).toBe(2); // append-per-rescore, history preserved

    const [b] = await admin`
      SELECT score_breakdown->'engagement'->>'replies' AS replies
      FROM scores WHERE contact_id = ${contactId} ORDER BY scored_at DESC LIMIT 1`;
    expect((b as { replies: string }).replies).toBe("1");
  });

  test("RLS: a wrong-workspace leadwolf_app session sees zero activities", async () => {
    const app = postgres(appUrl, { max: 1, onnotice: () => {} });
    try {
      const seenWrong = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${crypto.randomUUID()}, true)`;
        const [r] = await tx`SELECT count(*)::int AS n FROM activities`;
        return (r as { n: number }).n;
      });
      expect(seenWrong).toBe(0);

      const seenRight = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${wsA}, true)`;
        const [r] = await tx`SELECT count(*)::int AS n FROM activities`;
        return (r as { n: number }).n;
      });
      expect(seenRight).toBe(3);
    } finally {
      await app.end();
    }
  });

  test("sales_nav_links dedups on (workspace_id, url): the second insert is rejected", async () => {
    const url = "https://www.linkedin.com/sales/lead/ACwAAAExample";
    const scope = { tenantId: tenantA, workspaceId: wsA };

    const id = await withTenantTx(scope, (tx) =>
      salesNavLinkRepository.insert(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        linkType: "profile",
        url,
        externalId: "ACwAAAExample",
        createdByUserId: ownerA,
      }),
    );
    expect(id).toBeTruthy();
    const links = await salesNavLinkRepository.listByWorkspace(scope);
    expect(links.map((l) => l.url)).toEqual([url]);

    // postgres.js queries are lazy thenables — wrap in `async () => await q` before asserting rejection.
    const rejectionOf = async (run: () => Promise<unknown>): Promise<unknown> => {
      try {
        await run();
        return null;
      } catch (err) {
        return err;
      }
    };
    const dup = await rejectionOf(
      async () =>
        await admin`
        INSERT INTO sales_nav_links (tenant_id, workspace_id, link_type, url)
        VALUES (${tenantA}, ${wsA}, 'profile', ${url})`,
    );
    expect(String(dup)).toContain("duplicate key");
    expect(String(dup)).toContain("uniq_sales_nav_links_ws_url");
  });
});
