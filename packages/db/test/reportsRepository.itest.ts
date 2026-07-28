// reportsRepository.itest.ts — the server-side report aggregates (C-3.10) against a real Postgres.
//
// These replace rollups that ran in the browser over the most recent 200 rows, so the ONE thing that must be
// true of them is that they count the whole workspace. Everything here is arranged around the ways that can
// silently fail to hold:
//
//   • the day buckets must follow the VIEWER's local day, not UTC — that is what the old client-side rollup
//     did, and getting it wrong shifts every chart for non-UTC users without erroring;
//   • the team rollup joins two DIFFERENT populations (contacts you own, reveals you paid for), so an inner
//     join would quietly drop every member who sits on only one side;
//   • the member dropdown must keep listing everyone even while filtered to one member, or selecting a member
//     strands the filter there;
//   • RLS must still scope everything, because none of this SQL carries a workspace predicate of its own.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { applyMigrations } from "../src/applyMigrations.ts";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("../src/index.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;
let tenantId = "";
let workspaceId = "";
let alice = "";
let bob = "";

const scope = () => ({ tenantId, workspaceId });

beforeAll(async () => {
  dbHandle = await startItestDb("reports_repository");
  await applyMigrations(dbHandle.adminUrl);
  process.env.DATABASE_URL = dbHandle.adminUrl;
  admin = postgres(dbHandle.adminUrl, { max: 1 });
  db = await import("../src/index.ts");

  const slug = `rep-${Date.now()}`;
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  tenantId = (t as { id: string }).id;
  const [a] = await admin`INSERT INTO users (email) VALUES (${`alice@${slug}.test`}) RETURNING id`;
  alice = (a as { id: string }).id;
  const [b] = await admin`INSERT INTO users (email) VALUES (${`bob@${slug}.test`}) RETURNING id`;
  bob = (b as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${alice}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${alice}) RETURNING id`;
  workspaceId = (w as { id: string }).id;

  // Alice owns two contacts (one replied → engaged), Bob owns one. Statuses and email presence are chosen so
  // the funnel, health and coverage numbers are all distinguishable from each other.
  await admin`
    INSERT INTO contacts (tenant_id, workspace_id, first_name, last_name, owner_user_id, outreach_status,
                          email_status, email_enc)
    VALUES
      (${tenantId}, ${workspaceId}, 'A', 'One',   ${alice}, 'replied',     'valid',       '\\x01'::bytea),
      (${tenantId}, ${workspaceId}, 'A', 'Two',   ${alice}, 'new',         'unverified',  NULL),
      (${tenantId}, ${workspaceId}, 'B', 'Three', ${bob},   'in_sequence', 'valid',       '\\x02'::bytea)`;

  // Reveals: Alice spends 3 credits on one UTC day, Bob 1 on another. The first is placed at 20:00 UTC so a
  // viewer in Asia/Kolkata (+05:30) sees it on the NEXT local day — the whole point of the tz parameter.
  const contactIds =
    await admin`SELECT id FROM contacts WHERE workspace_id = ${workspaceId} ORDER BY first_name, last_name`;
  const cid = (i: number) => (contactIds[i] as { id: string }).id;
  await admin`
    INSERT INTO contact_reveals (tenant_id, workspace_id, contact_id, revealed_by_user_id, reveal_type,
                                 credits_consumed, revealed_at)
    VALUES
      (${tenantId}, ${workspaceId}, ${cid(0)}, ${alice}, 'email', 3, '2026-03-10T20:00:00Z'),
      (${tenantId}, ${workspaceId}, ${cid(2)}, ${bob},   'phone', 1, '2026-03-12T06:00:00Z')`;
});

afterAll(async () => {
  await db?.closeDb?.();
  await admin.end({ timeout: 5 });
  await dbHandle.stop();
});

const filters = (
  over: Partial<{ since: Date | null; memberId: string | null; tz: string }> = {},
) => ({
  since: null,
  memberId: null,
  tz: "UTC",
  ...over,
});

describe("reportsRepository.summary", () => {
  test("counts the whole workspace — not a page of it", async () => {
    const s = await db.reportsRepository.summary(scope(), filters());
    expect(s.contactTotal).toBe(3);
    // Coverage counts the PRESENCE of encrypted email, never decrypting it.
    expect(s.withEmail).toBe(2);

    const funnel = Object.fromEntries(s.funnel.map((f) => [f.status, f.count]));
    expect(funnel).toMatchObject({ replied: 1, new: 1, in_sequence: 1 });

    const health = Object.fromEntries(s.health.map((h) => [h.status, h.count]));
    expect(health).toMatchObject({ valid: 2, unverified: 1 });
  });

  test("day buckets follow the VIEWER's zone, not UTC", async () => {
    const utc = await db.reportsRepository.summary(scope(), filters({ tz: "UTC" }));
    const utcDays = Object.fromEntries(utc.creditsByDay.map((d) => [d.day, d.credits]));
    expect(utcDays["2026-03-10"]).toBe(3);

    // 20:00 UTC on the 10th is 01:30 on the 11th in Asia/Kolkata. A UTC-only aggregate would report the 10th
    // for this viewer too — which is exactly the regression the tz parameter exists to prevent.
    const ist = await db.reportsRepository.summary(scope(), filters({ tz: "Asia/Kolkata" }));
    const istDays = Object.fromEntries(ist.creditsByDay.map((d) => [d.day, d.credits]));
    expect(istDays["2026-03-11"]).toBe(3);
    expect(istDays["2026-03-10"]).toBeUndefined();
  });

  test("spend splits by reveal type", async () => {
    const s = await db.reportsRepository.summary(scope(), filters());
    const byType = Object.fromEntries(s.creditsByType.map((t) => [t.revealType, t.credits]));
    expect(byType).toMatchObject({ email: 3, phone: 1 });
  });

  test("the team rollup keeps members who only own OR only spent", async () => {
    const s = await db.reportsRepository.summary(scope(), filters());
    const team = Object.fromEntries(s.team.map((r) => [r.userId, r]));
    // Alice: 2 owned, 1 of them engaged, 3 credits.
    expect(team[alice]).toMatchObject({ revealed: 2, engaged: 1, credits: 3 });
    // Bob: 1 owned, none engaged, 1 credit.
    expect(team[bob]).toMatchObject({ revealed: 1, engaged: 0, credits: 1 });
    expect(s.team).toHaveLength(2);
  });

  test("the member filter narrows the counts but NOT the dropdown", async () => {
    const s = await db.reportsRepository.summary(scope(), filters({ memberId: bob }));
    expect(s.contactTotal).toBe(1);
    expect(s.team).toHaveLength(1);
    // The options must still offer Alice, or picking Bob would strand the filter on Bob forever.
    expect(s.memberOptions).toEqual(expect.arrayContaining([alice, bob]));
  });

  test("the date range bounds both sides", async () => {
    const s = await db.reportsRepository.summary(
      scope(),
      filters({ since: new Date("2026-03-11T00:00:00Z") }),
    );
    // Only Bob's reveal is inside the window; Alice's predates it.
    const byType = Object.fromEntries(s.creditsByType.map((t) => [t.revealType, t.credits]));
    expect(byType.phone).toBe(1);
    expect(byType.email).toBeUndefined();
  });

  test("an empty workspace returns zeroes rather than throwing", async () => {
    const slug = `rep-empty-${Date.now()}`;
    const [t2] =
      await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
    const emptyTenant = (t2 as { id: string }).id;
    const [w2] = await admin`
      INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
      VALUES (${emptyTenant}, ${slug}, ${slug}, true, ${alice}) RETURNING id`;
    const s = await db.reportsRepository.summary(
      { tenantId: emptyTenant, workspaceId: (w2 as { id: string }).id },
      filters(),
    );
    expect(s).toMatchObject({ contactTotal: 0, withEmail: 0 });
    expect(s.funnel).toEqual([]);
    expect(s.team).toEqual([]);
  });
});
