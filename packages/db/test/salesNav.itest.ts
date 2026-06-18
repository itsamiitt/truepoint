// salesNav.itest.ts — the M7 Sales Navigator assisted-capture Definition-of-Done proof on a real Postgres 16
// (10/14 §3.5): Testcontainers by default, or an external server via ITEST_DATABASE_URL (see itestDb.ts).
// Named *.itest.ts so default `bun test` skips it; run in its OWN process (the db client is a module
// singleton): `bun test packages/db/test/salesNav.itest.ts`.
//
// Proves the HITL capture invariants (05 §5, ADR-0009): (1) a pasted link persists workspace-scoped, with the
// parsed sales_nav_lead_id + note/labels round-tripping; (2) re-pasting the same (workspace_id, url) DEDUPS
// onto the existing row (no copy, deduped:true); (3) the same lead via a DIFFERENT url still dedups on
// (workspace_id, sales_nav_lead_id); (4) a captured link is deletable and gone from the list; (5) RLS
// isolation — a wrong-workspace leadwolf_app session sees ZERO of another workspace's links, and the SAME
// url captured in two workspaces is two independent rows.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let core: Core;
let admin: ReturnType<typeof postgres>;
let appUrl = "";
let withTenantTx: DbModule["withTenantTx"];
let salesNavLinkRepository: DbModule["salesNavLinkRepository"];

let tenantA = "";
let tenantB = "";
let wsA = "";
let wsB = "";
let ownerA = "";
let ownerB = "";

async function seedWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id, ownerId: u!.id };
}

/** Count links a leadwolf_app session sees for a given workspace GUC (the real RLS-enforced read path). */
async function appLinkCountFor(workspaceId: string): Promise<number> {
  const app = postgres(appUrl, { max: 1, onnotice: () => {} });
  try {
    return await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
      const [r] = await tx`SELECT count(*)::int AS n FROM sales_nav_links`;
      return (r as { n: number }).n;
    });
  } finally {
    await app.end();
  }
}

beforeAll(async () => {
  dbHandle = await startItestDb("salesNav");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  appUrl = dbHandle.appUrl;

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB, ownerId: ownerB } = await seedWorkspace("globex"));

  core = await import("../../core/src/index.ts");
  ({ withTenantTx, salesNavLinkRepository } = await import("@leadwolf/db"));
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("M7 Sales Navigator assisted-capture DoD", () => {
  const leadUrl = "https://www.linkedin.com/sales/lead/ACwAAABcDeF123,NAME_SEARCH";

  test("a pasted link persists workspace-scoped with parsed lead id + note/labels round-tripping", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsA };
    const res = await core.captureSalesNavLink({
      scope,
      linkType: "profile",
      url: leadUrl,
      note: "Warm intro from Dana",
      labels: ["q3", "champion"],
      capturedByUserId: ownerA,
    });
    expect(res.deduped).toBe(false);
    expect(res.id).toBeTruthy();

    const links = await salesNavLinkRepository.listByWorkspace(scope);
    expect(links.length).toBe(1);
    const link = links[0]!;
    expect(link.url).toBe(leadUrl);
    expect(link.linkType).toBe("profile");
    expect(link.note).toBe("Warm intro from Dana");
    expect(link.labels).toEqual(["q3", "champion"]);
    // The parser pulled the lead id out of /sales/lead/<id>,<extra> (the comma-suffix is stripped). No
    // human external_id was supplied, so external_id stays null — only the parsed dedup facet is set.
    expect(link.salesNavLeadId).toBe("ACwAAABcDeF123");
    expect(link.externalId).toBeNull();
  });

  test("re-pasting the same (workspace_id, url) dedups onto the existing row (no copy)", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsA };
    const before = await salesNavLinkRepository.listByWorkspace(scope);
    const res = await core.captureSalesNavLink({
      scope,
      linkType: "profile",
      url: leadUrl,
      capturedByUserId: ownerA,
    });
    expect(res.deduped).toBe(true);
    expect(res.id).toBe(before[0]!.id); // same surviving row
    const after = await salesNavLinkRepository.listByWorkspace(scope);
    expect(after.length).toBe(before.length); // unchanged — no accumulation
  });

  test("the same lead via a different url still dedups on (workspace_id, sales_nav_lead_id)", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsA };
    const before = await salesNavLinkRepository.listByWorkspace(scope);
    // A different URL form (/sales/people/<id>) that parses to the SAME lead id.
    const res = await core.captureSalesNavLink({
      scope,
      linkType: "profile",
      url: "https://www.linkedin.com/sales/people/ACwAAABcDeF123",
      capturedByUserId: ownerA,
    });
    expect(res.deduped).toBe(true);
    const after = await salesNavLinkRepository.listByWorkspace(scope);
    expect(after.length).toBe(before.length); // still one row for this lead
  });

  test("a captured link is deletable and gone from the list", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsA };
    const listUrl = "https://www.linkedin.com/sales/lists/people/9988";
    const created = await core.captureSalesNavLink({
      scope,
      linkType: "lead_list",
      url: listUrl,
      capturedByUserId: ownerA,
    });
    expect(created.deduped).toBe(false);
    expect(
      (await salesNavLinkRepository.listByWorkspace(scope)).some((l) => l.id === created.id),
    ).toBe(true);

    const removed = await salesNavLinkRepository.deleteById(scope, created.id);
    expect(removed).toBe(true);
    expect(
      (await salesNavLinkRepository.listByWorkspace(scope)).some((l) => l.id === created.id),
    ).toBe(false);

    // Deleting a non-existent / already-deleted id is a no-op (false), not an error.
    expect(await salesNavLinkRepository.deleteById(scope, created.id)).toBe(false);
  });

  test("RLS: the same url in two workspaces are independent rows; a wrong-workspace session sees zero", async () => {
    const sharedUrl = "https://www.linkedin.com/sales/company/55555";
    const a = await core.captureSalesNavLink({
      scope: { tenantId: tenantA, workspaceId: wsA },
      linkType: "account",
      url: sharedUrl,
      capturedByUserId: ownerA,
    });
    const b = await core.captureSalesNavLink({
      scope: { tenantId: tenantB, workspaceId: wsB },
      linkType: "account",
      url: sharedUrl,
      capturedByUserId: ownerB,
    });
    // Same URL, two workspaces → two distinct rows (dedup is per-workspace, not global).
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(false);
    expect(a.id).not.toBe(b.id);

    // B's scoped list never includes A's links and vice-versa.
    const bLinks = await salesNavLinkRepository.listByWorkspace({
      tenantId: tenantB,
      workspaceId: wsB,
    });
    expect(bLinks.map((l) => l.url)).toEqual([sharedUrl]); // only B's single capture
    expect(bLinks.every((l) => l.id !== a.id)).toBe(true);

    // The non-BYPASSRLS app role sees exactly its own workspace's rows under each GUC, and zero for a random one.
    const countB = await appLinkCountFor(wsB);
    expect(countB).toBe(1);
    const countRandom = await appLinkCountFor(crypto.randomUUID());
    expect(countRandom).toBe(0);
  });

  test("withTenantTx insertDedup reports deduped:true for a re-inserted url within the tx scope", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsA };
    const url = "https://www.linkedin.com/sales/search/people?savedSearchId=42";
    const first = await withTenantTx(scope, (tx) =>
      salesNavLinkRepository.insertDedup(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        linkType: "saved_search",
        url,
        createdByUserId: ownerA,
      }),
    );
    expect(first.deduped).toBe(false);
    const second = await withTenantTx(scope, (tx) =>
      salesNavLinkRepository.insertDedup(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        linkType: "saved_search",
        url,
        createdByUserId: ownerA,
      }),
    );
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
  });
});
