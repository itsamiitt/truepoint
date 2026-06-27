// templateIsolation.itest.ts — the cross-tenant isolation + D8 ownership proof for the M12 P2 template editor
// (email-planning/13 P2, the security mandate). On a real Postgres 16 (Testcontainers by default, or an
// external server via ITEST_DATABASE_URL). Run in its OWN process (the db client is a module singleton):
// `bun test ./packages/db/test/templateIsolation.itest.ts`.
//
// Unlike the raw-SQL email isolation itest, this drives the CORE service (createTemplate / getTemplate /
// listTemplates / updateTemplate / listTemplateVersions / restoreVersion / previewTemplate) end-to-end through
// withTenantTx + RLS, proving the full stack: (1) RLS workspace isolation (a wrong-workspace GUC sees zero);
// (2) D8 owner-scope — a private template is visible only to its owner, a shared one to the workspace, and only
// the OWNER may edit/restore (a non-owner gets ForbiddenError, a non-visible id gets NotFound → IDOR-safe);
// (3) versions are immutable + append-only and history reads back; (4) keyset pagination returns every row
// once, in order, with no dup/skip; (5) the server-side preview renders merge fields SAFELY (values escaped).
// Core is imported via the relative barrel (../../core/src/index.ts) — packages/db doesn't declare @leadwolf/core
// as a dep, so the package-name import would fail to resolve (the documented cross-package itest workaround).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");
type CoreModule = typeof import("../../core/src/index.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let dbmod: DbModule;
let core: CoreModule;

let tenantA = "";
let wsA = "";
let ownerA = "";
let otherA = ""; // a second user in workspace A — proves owner-scope vs workspace-share (D8)

let tenantB = "";
let wsB = "";
let ownerB = "";

let privateId = ""; // owned by ownerA, NOT shared
let sharedId = ""; // owned by ownerA, shared with the workspace

interface Seeded {
  tenantId: string;
  wsId: string;
  ownerId: string;
}

async function seedTenant(slug: string): Promise<Seeded> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  const wsId = (w as { id: string }).id;
  return { tenantId, wsId, ownerId };
}

const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });

beforeAll(async () => {
  dbHandle = await startItestDb("templateIsolation");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });

  ({ tenantId: tenantA, wsId: wsA, ownerId: ownerA } = await seedTenant("acme"));
  ({ tenantId: tenantB, wsId: wsB, ownerId: ownerB } = await seedTenant("globex"));

  // A second user in tenant/workspace A — used to prove D8 (sees shared, not private; cannot edit).
  const [o] = await admin`INSERT INTO users (email) VALUES ('teammate@acme.test') RETURNING id`;
  otherA = (o as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id) VALUES (${tenantA}, ${otherA})`;

  // env is set above, BEFORE either singleton loads.
  dbmod = await import("@leadwolf/db");
  core = await import("../../core/src/index.ts");

  const priv = await core.createTemplate({
    scope: scopeA(),
    userId: ownerA,
    name: "Private intro",
    body: "Hi {{first_name | there}} — a private note.",
  });
  privateId = priv.id;
  const shared = await core.createTemplate({
    scope: scopeA(),
    userId: ownerA,
    name: "Shared intro",
    subject: "Hello from {{company}}",
    body: "Hi {{first_name}} at {{company}}.",
    shared: true,
  });
  sharedId = shared.id;
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

describe("M12 P2 template isolation + D8 ownership", () => {
  test("RLS (raw): a wrong-workspace GUC sees ZERO of workspace A's templates", async () => {
    const seen = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${wsB}, true)`;
      const [r] = await tx`SELECT count(*)::int AS n FROM email_template WHERE id = ${privateId}`;
      return (r as { n: number }).n;
    });
    expect(seen).toBe(0);
  });

  test("RLS (raw): workspace B cannot INSERT a template into workspace A (WITH CHECK)", async () => {
    let blocked = false;
    try {
      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${wsB}, true)`;
        await tx`
          INSERT INTO email_template (tenant_id, workspace_id, owner_user_id, name)
          VALUES (${tenantA}, ${wsA}, ${ownerB}, 'evil-cross')`;
      });
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
  });

  test("cross-tenant: workspace B's library never contains workspace A's templates", async () => {
    const { templates } = await core.listTemplates(scopeB(), ownerB);
    expect(templates.map((t) => t.id)).not.toContain(privateId);
    expect(templates.map((t) => t.id)).not.toContain(sharedId);
  });

  test("D8 list: the owner sees private + shared; a teammate sees ONLY the shared one", async () => {
    const ownerList = await core.listTemplates(scopeA(), ownerA);
    const ownerIds = ownerList.templates.map((t) => t.id);
    expect(ownerIds).toContain(privateId);
    expect(ownerIds).toContain(sharedId);

    const teammateList = await core.listTemplates(scopeA(), otherA);
    const teammateIds = teammateList.templates.map((t) => t.id);
    expect(teammateIds).toContain(sharedId);
    expect(teammateIds).not.toContain(privateId);
  });

  test("D8 get / IDOR: a teammate 404s on the private template, sees the shared one read-only", async () => {
    // The private template is indistinguishable from "absent" for a non-owner (IDOR-safe 404).
    let privCode = "";
    try {
      await core.getTemplate(scopeA(), otherA, privateId);
    } catch (e) {
      privCode = (e as { name?: string }).name ?? "";
    }
    expect(privCode).toBe("NotFoundError");

    const sharedView = await core.getTemplate(scopeA(), otherA, sharedId);
    expect(sharedView.canEdit).toBe(false);
    const ownerView = await core.getTemplate(scopeA(), ownerA, privateId);
    expect(ownerView.canEdit).toBe(true);

    // Cross-tenant get is a 404 too (RLS excludes the row).
    let xCode = "";
    try {
      await core.getTemplate(scopeB(), ownerB, privateId);
    } catch (e) {
      xCode = (e as { name?: string }).name ?? "";
    }
    expect(xCode).toBe("NotFoundError");
  });

  test("D8 edit: a non-owner cannot update or restore the owner's template (ForbiddenError)", async () => {
    let upCode = "";
    try {
      await core.updateTemplate({
        scope: scopeA(),
        userId: otherA,
        templateId: sharedId,
        content: { subject: null, body: "hijacked" },
      });
    } catch (e) {
      upCode = (e as { name?: string }).name ?? "";
    }
    expect(upCode).toBe("ForbiddenError");

    let resCode = "";
    try {
      await core.restoreVersion({
        scope: scopeA(),
        userId: otherA,
        templateId: sharedId,
        version: 1,
      });
    } catch (e) {
      resCode = (e as { name?: string }).name ?? "";
    }
    expect(resCode).toBe("ForbiddenError");
  });

  test("D8 edit / IDOR: a non-owner mutating a PRIVATE template gets 404, not 403 (existence stays hidden)", async () => {
    // A shared template a non-owner can SEE returns 403 on edit (above); a private one they can't see must
    // return 404 — the same indistinguishable-from-absent answer getTemplate gives, so the mutation endpoints
    // can't be used to probe which private ids exist.
    let upCode = "";
    try {
      await core.updateTemplate({
        scope: scopeA(),
        userId: otherA,
        templateId: privateId,
        content: { subject: null, body: "hijacked" },
      });
    } catch (e) {
      upCode = (e as { name?: string }).name ?? "";
    }
    expect(upCode).toBe("NotFoundError");

    let resCode = "";
    try {
      await core.restoreVersion({
        scope: scopeA(),
        userId: otherA,
        templateId: privateId,
        version: 1,
      });
    } catch (e) {
      resCode = (e as { name?: string }).name ?? "";
    }
    expect(resCode).toBe("NotFoundError");
  });

  test("versions are immutable + append-only; restore clones an old version into a NEW one", async () => {
    // Two content edits → versions 2 and 3.
    const v2 = await core.updateTemplate({
      scope: scopeA(),
      userId: ownerA,
      templateId: privateId,
      content: { subject: null, body: "v2 body" },
    });
    expect(v2.version).toBe(2);
    const v3 = await core.updateTemplate({
      scope: scopeA(),
      userId: ownerA,
      templateId: privateId,
      content: { subject: null, body: "v3 body" },
    });
    expect(v3.version).toBe(3);

    const history = await core.listTemplateVersions(scopeA(), ownerA, privateId);
    expect(history.map((h) => h.version)).toEqual([3, 2, 1]);
    // Version 1's body is unchanged by later edits (immutable).
    expect(history.find((h) => h.version === 1)?.body).toBe(
      "Hi {{first_name | there}} — a private note.",
    );

    // Restore version 1 → appends version 4 cloning v1's content; current content becomes v1's.
    const restored = await core.restoreVersion({
      scope: scopeA(),
      userId: ownerA,
      templateId: privateId,
      version: 1,
    });
    expect(restored.version).toBe(4);
    const detail = await core.getTemplate(scopeA(), ownerA, privateId);
    expect(detail.currentVersion).toBe(4);
    expect(detail.body).toBe("Hi {{first_name | there}} — a private note.");
    const after = await core.listTemplateVersions(scopeA(), ownerA, privateId);
    expect(after.map((h) => h.version)).toEqual([4, 3, 2, 1]);
  });

  test("keyset pagination returns every template once, newest-updated first, no dup/skip", async () => {
    // Create a clean owner with several templates so paging is deterministic.
    const [pu] = await admin`INSERT INTO users (email) VALUES ('pager@acme.test') RETURNING id`;
    const pager = (pu as { id: string }).id;
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await core.createTemplate({
        scope: scopeA(),
        userId: pager,
        name: `Pager ${i}`,
        body: `body ${i}`,
      });
      made.push(r.id);
    }
    // Page through with limit 2.
    const collected: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const pageRes = await core.listTemplates(scopeA(), pager, { limit: 2, cursor });
      collected.push(...pageRes.templates.map((t) => t.id));
      cursor = pageRes.nextCursor ?? undefined;
      guard++;
    } while (cursor && guard < 10);

    // No row is returned twice or skipped across pages — the keyset is exact. (The viewer also sees the
    // workspace-shared template from beforeAll, so the total is >5; we assert on the 5 we created.)
    expect(collected.length).toBe(new Set(collected).size);
    for (const id of made) expect(collected.filter((x) => x === id).length).toBe(1);
    // Newest-created (latest updated_at) comes first.
    expect(collected[0]).toBe(made[4]);
  });

  test("preview renders merge fields SERVER-SIDE and SAFELY (untrusted value escaped)", async () => {
    const preview = await core.previewTemplate({
      scope: scopeA(),
      userId: ownerA,
      templateId: sharedId,
      draft: { subject: "Hi {{first_name}}", body: "From {{company}}: {{first_name}}" },
      sample: { first_name: "<script>x</script>", company: "Acme" },
    });
    // Body: values HTML-escaped (no live <script>); known field resolved.
    expect(preview.body).toContain("From Acme:");
    expect(preview.body).toContain("&lt;script&gt;");
    expect(preview.body).not.toContain("<script>");
    // Subject: plain text (unescaped) by design.
    expect(preview.subject).toBe("Hi <script>x</script>");
    expect(preview.fields.sort()).toEqual(["company", "first_name"]);

    // A teammate can preview a shared template (read) but 404s on the private one.
    let code = "";
    try {
      await core.previewTemplate({ scope: scopeA(), userId: otherA, templateId: privateId });
    } catch (e) {
      code = (e as { name?: string }).name ?? "";
    }
    expect(code).toBe("NotFoundError");
  });

  test("archive is reversible: a template moves between the active and archived bins via the status filter", async () => {
    const [au] = await admin`INSERT INTO users (email) VALUES ('archiver@acme.test') RETURNING id`;
    const archiver = (au as { id: string }).id;
    const t = await core.createTemplate({
      scope: scopeA(),
      userId: archiver,
      name: "Archive me",
      body: "x",
    });

    const inActive = async () =>
      (await core.listTemplates(scopeA(), archiver, { status: "active" })).templates.map(
        (x) => x.id,
      );
    const inArchived = async () =>
      (await core.listTemplates(scopeA(), archiver, { status: "archived" })).templates.map(
        (x) => x.id,
      );

    // Created → active bin only.
    expect(await inActive()).toContain(t.id);
    expect(await inArchived()).not.toContain(t.id);

    // Archive → leaves active, enters archived (so the UI can still reach + restore it).
    await core.updateTemplate({
      scope: scopeA(),
      userId: archiver,
      templateId: t.id,
      status: "archived",
    });
    expect(await inActive()).not.toContain(t.id);
    expect(await inArchived()).toContain(t.id);

    // Restore → back in the active bin.
    await core.updateTemplate({
      scope: scopeA(),
      userId: archiver,
      templateId: t.id,
      status: "active",
    });
    expect(await inActive()).toContain(t.id);
  });
});
