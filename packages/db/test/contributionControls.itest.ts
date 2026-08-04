// contributionControls.itest.ts — the behavioural proof of the Phase 4 contribution controls (migration 0097,
// contributionPolicyRepository, core/prospect/contributionGate.ts, decisions.md D13).
//
// Four properties, none of which can be checked without a real Postgres:
//   1. A workspace with NO controls set mints exactly as it did before the gate existed (D13's opt-out shape —
//      the one property whose failure would silently stop the dedup spine growing for every existing tenant).
//   2. An excluded domain still LINKs to a person the graph already holds, and mints nothing new. The link
//      half matters as much as the deny half: gating it too would be a product downgrade wearing a privacy
//      control's name, and only a real master_persons row can tell the two apart.
//   3. never_share_fields subtract facets from an otherwise-permitted mint — the person exists, the email
//      blind index does not.
//   4. RLS: one workspace's exclusions are invisible to another. A deny list that leaks across the tenancy
//      wall would let a neighbour enumerate which accounts a competitor considers strategic.
//
// Run in its OWN process (the db client is a module singleton and env is set before it loads):
//   bun test ./packages/db/test/contributionControls.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");
// Core via the RELATIVE barrel, not @leadwolf/core: packages/db must not depend on core (Turbo cycle).
type CoreModule = typeof import("../../core/src/index.ts");

const BI_KNOWN = new Uint8Array([21, 22, 23, 24]);
const BI_FRESH = new Uint8Array([31, 32, 33, 34]);
const BI_WITHHELD = new Uint8Array([41, 42, 43, 44]);

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;
let core: CoreModule;

let tenantA = "";
let tenantB = "";
let wsA = "";
let wsB = "";
let ownerA = "";
let knownPersonId = "";

async function seedTenant(
  slug: string,
): Promise<{ tenantId: string; wsId: string; owner: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const owner = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner)
              VALUES (${tenantId}, ${owner}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${owner}) RETURNING id`;
  return { tenantId, wsId: (w as { id: string }).id, owner };
}

async function masterPersonCount(): Promise<number> {
  const [r] = await admin`SELECT count(*)::int AS n FROM master_persons`;
  return (r as { n: number }).n;
}

async function bridgeOf(contactId: string): Promise<string | null> {
  const [r] = await admin`SELECT master_person_id FROM contacts WHERE id = ${contactId}`;
  return (r as { master_person_id: string | null }).master_person_id;
}

/** Seed one unresolved overlay contact in wsA and return its id. */
async function seedContact(fields: {
  linkedin?: string;
  blindIndex?: Uint8Array;
  emailDomain?: string;
  accountId?: string;
}): Promise<string> {
  const [c] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, account_id, linkedin_public_id, email_blind_index, email_domain)
    VALUES (${tenantA}, ${wsA}, ${fields.accountId ?? null}, ${fields.linkedin ?? null},
            ${fields.blindIndex ?? null}, ${fields.emailDomain ?? null})
    RETURNING id`;
  return (c as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("contributionControls");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  ({ tenantId: tenantA, wsId: wsA, owner: ownerA } = await seedTenant("acme"));
  ({ tenantId: tenantB, wsId: wsB } = await seedTenant("globex"));

  // A golden person the shared graph ALREADY holds, reachable by an email blind index. Excluded rows must
  // still link to this — that is the difference between "stop contributing" and "stop working".
  const [mp] = await admin`
    INSERT INTO master_persons (linkedin_public_id, has_email, has_phone)
    VALUES ('known-person', false, false) RETURNING id`;
  knownPersonId = (mp as { id: string }).id;
  await admin`INSERT INTO master_emails (master_person_id, email_blind_index, email_domain)
              VALUES (${knownPersonId}, ${BI_KNOWN}, 'strategic.com')`;

  dbmod = await import("@leadwolf/db");
  core = await import("../../core/src/index.ts");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });

describe("contribution controls (Phase 4, D13)", () => {
  test("a workspace with NO controls set mints exactly as before — the gate is an opt-OUT", async () => {
    // The property whose failure is invisible and expensive: default-deny would stop the dedup spine growing
    // for every existing tenant on migration day, with every other assertion in the suite still passing.
    const before = await masterPersonCount();
    const c = await seedContact({ linkedin: "unrestricted-person" });

    const res = await core.runMasterBackfill(scopeA());

    expect(res.errored).toBe(0);
    expect(res.mintSuppressed).toBe(0);
    expect(await bridgeOf(c)).toBeTruthy();
    expect(await masterPersonCount()).toBe(before + 1);
  });

  test("an excluded domain still LINKs to a known person but MINTS nothing new", async () => {
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.contributionPolicyRepository.addExclusion(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        kind: "domain",
        domain: "strategic.com",
        note: "our own customers",
        createdByUserId: ownerA,
      }),
    );

    // Two rows on the excluded domain: one the graph already knows (must LINK), one it does not (must NOT mint).
    const linkable = await seedContact({ blindIndex: BI_KNOWN, emailDomain: "strategic.com" });
    const fresh = await seedContact({
      linkedin: "strategic-newcomer",
      blindIndex: BI_FRESH,
      emailDomain: "strategic.com",
    });

    const before = await masterPersonCount();
    const res = await core.runMasterBackfill(scopeA());

    expect(res.errored).toBe(0);
    // The known person is still reachable — the customer keeps every benefit of what is already shared.
    expect(await bridgeOf(linkable)).toBe(knownPersonId);
    // The unknown one contributes nothing and stays in in-flight staging, re-resolvable for free the day the
    // exclusion is lifted or an outside source mints the person independently.
    expect(await bridgeOf(fresh)).toBeNull();
    expect(res.mintSuppressed).toBeGreaterThanOrEqual(1);
    expect(await masterPersonCount()).toBe(before);
    // And nothing on the excluded domain reached the company table either.
    const [co] =
      await admin`SELECT count(*)::int AS n FROM master_companies WHERE primary_domain = 'strategic.com'`;
    expect((co as { n: number }).n).toBe(0);
  });

  test("an excluded ACCOUNT is denied even when its domain is not listed", async () => {
    const [a] = await admin`
      INSERT INTO accounts (tenant_id, workspace_id, name, domain)
      VALUES (${tenantA}, ${wsA}, 'Quiet Co', 'quiet.com') RETURNING id`;
    const accountId = (a as { id: string }).id;
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.contributionPolicyRepository.addExclusion(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        kind: "account",
        accountId,
        createdByUserId: ownerA,
      }),
    );
    const c = await seedContact({ linkedin: "quiet-person", accountId, emailDomain: "quiet.com" });

    const before = await masterPersonCount();
    await core.runMasterBackfill(scopeA());

    expect(await bridgeOf(c)).toBeNull();
    expect(await masterPersonCount()).toBe(before);
  });

  test("never_share_fields subtract facets from a PERMITTED mint", async () => {
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.contributionPolicyRepository.upsertPolicy(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        contributeEnabled: false,
        neverShareFields: ["email"],
        enabledByUserId: ownerA,
      }),
    );
    // contributeEnabled is false and the withholding still applies — a restriction binds regardless of the
    // co-op switch (D13), which is the half of the rule most likely to be got wrong.
    const c = await seedContact({
      linkedin: "withheld-email-person",
      blindIndex: BI_WITHHELD,
      emailDomain: "elsewhere.com",
    });

    await core.runMasterBackfill(scopeA());

    const bridge = await bridgeOf(c);
    // The person mints — identity is not what was withheld.
    expect(bridge).toBeTruthy();
    // The email facet does not. Asserted on the blind index specifically: the contact resolved, so a naive
    // implementation that wrote master_emails anyway would pass every other assertion here.
    const [e] = await admin`
      SELECT count(*)::int AS n FROM master_emails WHERE email_blind_index = ${BI_WITHHELD}`;
    expect((e as { n: number }).n).toBe(0);
  });

  test("one workspace's exclusion list is invisible to another (RLS)", async () => {
    // wsA has three exclusions by now. wsB must see none of them — a deny list that leaked across the tenancy
    // wall would let a neighbour enumerate which accounts a competitor considers strategic.
    const mine = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.contributionPolicyRepository.listExclusions(tx),
    );
    expect(mine.length).toBeGreaterThanOrEqual(2);

    const theirs = await dbmod.withTenantTx({ tenantId: tenantB, workspaceId: wsB }, (tx) =>
      dbmod.contributionPolicyRepository.listExclusions(tx),
    );
    expect(theirs).toEqual([]);

    // And wsB resolves to the unrestricted default, so wsA's rules never bind wsB's backfill.
    const policyB = await dbmod.withTenantTx({ tenantId: tenantB, workspaceId: wsB }, (tx) =>
      dbmod.contributionPolicyRepository.resolve(tx),
    );
    expect(policyB.excludedDomains.size).toBe(0);
    expect(policyB.neverShareFields).toEqual([]);
  });

  test("a workspace cannot write an exclusion into another workspace", async () => {
    // The WITH CHECK half of the policy. Under FORCE RLS an INSERT that fails the check RAISES, so this is
    // asserted by capturing the rejection rather than by reading state afterwards.
    let err: unknown = null;
    try {
      await dbmod.withTenantTx({ tenantId: tenantB, workspaceId: wsB }, (tx) =>
        dbmod.contributionPolicyRepository.addExclusion(tx, {
          tenantId: tenantA,
          workspaceId: wsA,
          kind: "domain",
          domain: "smuggled.com",
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();

    const mine = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.contributionPolicyRepository.listExclusions(tx),
    );
    expect(mine.some((x) => x.domain === "smuggled.com")).toBe(false);
  });

  test("revoking the policy turns the co-op switch off without erasing the record", async () => {
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.contributionPolicyRepository.upsertPolicy(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        contributeEnabled: true,
        neverShareFields: ["email"],
        enabledByUserId: ownerA,
      }),
    );
    const on = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.contributionPolicyRepository.resolve(tx),
    );
    expect(on.contributeEnabled).toBe(true);

    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.contributionPolicyRepository.upsertPolicy(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        contributeEnabled: false,
        neverShareFields: ["email"],
      }),
    );
    const off = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.contributionPolicyRepository.resolve(tx),
    );
    expect(off.contributeEnabled).toBe(false);
    // The restriction survives the revocation — honouring a restriction is never wrong.
    expect(off.neverShareFields).toEqual(["email"]);
    // And the revocation is RECORDED, not erased (09 rule 5: logged AND revocable).
    const [row] = await admin`
      SELECT revoked_at FROM contribution_policy WHERE workspace_id = ${wsA}`;
    expect((row as { revoked_at: Date | null }).revoked_at).not.toBeNull();
  });
});
