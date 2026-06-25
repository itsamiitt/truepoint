// masterBackfill.itest.ts — the behavioural proof of the master-link BACKFILL (core/prospect/backfillMaster.ts
// runMasterBackfill; PLAN_00 §11.5 / PLAN_07 Stage B). Where runImport resolves a row's master_person_id AS IT
// LANDS, this job resolves the EXISTING overlay contacts that landed BEFORE resolution existed (or whose per-row
// resolve failed non-fatally) and left contacts.master_person_id NULL = in-flight ER staging (ADR-0021). It walks
// ONE workspace in keyset-paged batches and re-resolves each unresolved contact through THE SAME Phase-2′ resolver
// the import path uses (masterGraphRepository.resolveForImport), stamping contacts.master_person_id and — when the
// contact has an account and ER resolved a company — accounts.master_company_id.
//
// On a real Postgres 16 (Testcontainers by default, or an external server via ITEST_DATABASE_URL — see itestDb.ts).
// Run in its OWN process (the db client is a module singleton, and DATABASE_URL/BLIND_INDEX_KEY are set BEFORE the
// singleton loads): `bun test ./packages/db/test/masterBackfill.itest.ts`.
//
// Tx topology mirrors runImport's split-role access: the overlay reads/stamps run under leadwolf_app (withTenantTx,
// RLS-scoped to the caller's workspace via the tx GUC — isolation rides the tx, no explicit workspace predicate),
// while the master-graph resolution runs under the least-privilege leadwolf_er role (withErTx). The system-owned
// master_* tables are NOT readable by leadwolf_app, so all Layer-0 fixtures/assertions use the privileged `admin`
// (owner) connection. runMasterBackfill is imported via the RELATIVE core barrel (../../core/src/index.ts), NOT as
// an @leadwolf/core db dependency, to avoid a db→core turbo build cycle (the established db-itest pattern).
//
// ── A NOTE ON THE DEDUP FIXTURE (why c1 and c2 do NOT share a blind index in the SAME workspace) ────────────────
// The "two overlay copies → one golden person" dedup is a Layer-0 (master-graph) property, keyed on the GLOBALLY
// unique master_emails.email_blind_index / master_persons.linkedin_public_id. But the OVERLAY enforces per-workspace
// partial-unique indexes — uniq_contacts_ws_email (workspace_id, email_blind_index) and uniq_contacts_ws_linkedin —
// so two unresolved contacts in ONE workspace can NEVER share a single overlay dedup key (import-time dedup already
// collapsed them). To prove master-level dedup WITHOUT violating those constraints, we pre-seed ONE golden person
// reachable by TWO different deterministic keys — linkedin 'alice' AND master_emails(BI1) — then give c1 the linkedin
// key and c2 the email key. Both resolve (LINK) to that SAME golden person: dedup, schema-valid.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type RunMasterBackfillFn = typeof import("../../core/src/index.ts")["runMasterBackfill"];

// The shared email blind index for the dedup pair — an opaque HMAC dedup key (never decoded). postgres.js binds a
// Uint8Array as bytea, so the SAME value seeded on BOTH the pre-seeded master_emails row and the c2 contact matches
// byte-for-byte under the resolver's email_blind_index comparison (the established pattern in the model itest).
const BI1 = new Uint8Array([1, 2, 3, 4]);
// wsB's contact carries a DISTINCT blind index — it must remain entirely untouched by wsA's backfill.
const BI3 = new Uint8Array([10, 11, 12, 13]);

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let runMasterBackfill: RunMasterBackfillFn;

let tenantA = "";
let tenantB = "";
let wsA = "";
let wsB = "";

// Workspace-A fixture ids, seeded in beforeAll and asserted across the tests.
let c1 = "";
let c2 = "";
let c3 = "";
let c4 = "";
let acmeAccount = "";
// Workspace-B fixture id — the RLS-isolation control row.
let cB = "";
// The pre-seeded shared golden person c1 (by linkedin) and c2 (by email) both LINK to.
let sharedPersonId = "";

interface Seeded {
  tenantId: string;
  wsId: string;
  ownerId: string;
}

// One tenant + owner + default workspace, seeded via the privileged admin connection (mirrors the model itests).
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

// Read a master_persons count via the PRIVILEGED admin connection (leadwolf_app has no grant on the master graph).
async function masterPersonCount(): Promise<number> {
  const [r] = await admin`SELECT count(*)::int AS n FROM master_persons`;
  return (r as { n: number }).n;
}

// Read one contact's master_person_id via admin (the value is an overlay column, but we read uniformly via admin).
async function masterPersonIdOf(contactId: string): Promise<string | null> {
  const [r] = await admin`SELECT master_person_id FROM contacts WHERE id = ${contactId}`;
  return (r as { master_person_id: string | null }).master_person_id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("masterBackfill");
  // env MUST be set before the db singleton (and core, which imports it) loads.
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  // admin = privileged owner connection (ALL master-graph + cross-workspace seeding/assertions); app = the
  // non-BYPASSRLS leadwolf_app role, here only to anchor that the base URL is the admin URL.
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });

  ({ tenantId: tenantA, wsId: wsA } = await seedTenant("acme"));
  ({ tenantId: tenantB, wsId: wsB } = await seedTenant("globex"));

  // Import the function under test via the RELATIVE core barrel AFTER env is set (so the db singleton core pulls in
  // is configured against this test database). Never add @leadwolf/core as a db dep — that creates a build cycle.
  ({ runMasterBackfill } = await import("../../core/src/index.ts"));

  // ── Pre-seed the shared golden person (Layer-0, via admin) ────────────────────────────────────────────────────
  // A single master_persons row reachable by TWO deterministic keys: linkedin 'alice' (the strongest person key) and
  // master_emails(BI1). c1 will LINK by linkedin, c2 by email → both resolve to THIS person (master-level dedup).
  const [mp] = await admin`
    INSERT INTO master_persons (linkedin_public_id, has_email, has_phone)
    VALUES ('alice', false, false) RETURNING id`;
  sharedPersonId = (mp as { id: string }).id;
  await admin`
    INSERT INTO master_emails (master_person_id, email_blind_index, email_domain)
    VALUES (${sharedPersonId}, ${BI1}, 'acme.com')`;

  // ── Workspace A overlay fixtures (all with master_person_id NULL = unresolved) ───────────────────────────────
  // The Acme account c1 and c2 share — its master_company_id starts NULL and must be stamped by the backfill.
  const [a] = await admin`
    INSERT INTO accounts (tenant_id, workspace_id, name, domain)
    VALUES (${tenantA}, ${wsA}, 'Acme', 'acme.com') RETURNING id`;
  acmeAccount = (a as { id: string }).id;

  // c1 — linkedin 'alice' + the Acme account. Resolves: company by 'acme.com' (mints), person by linkedin → shared.
  const [r1] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, account_id, linkedin_public_id, email_domain)
    VALUES (${tenantA}, ${wsA}, ${acmeAccount}, 'alice', 'acme.com') RETURNING id`;
  c1 = (r1 as { id: string }).id;

  // c2 — the SAME email blind index BI1 (no linkedin) + the SAME Acme account. Resolves: company by 'acme.com'
  // (the Acme company c1 minted), person by master_emails(BI1) → the SAME shared person as c1 (the dedup proof).
  const [r2] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, account_id, email_blind_index, email_domain)
    VALUES (${tenantA}, ${wsA}, ${acmeAccount}, ${BI1}, 'acme.com') RETURNING id`;
  c2 = (r2 as { id: string }).id;

  // c3 — linkedin 'bob', NO email, NO account. A clean miss → MINTs its OWN fresh golden person (company-less).
  const [r3] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, linkedin_public_id)
    VALUES (${tenantA}, ${wsA}, 'bob') RETURNING id`;
  c3 = (r3 as { id: string }).id;

  // c4 — NO identity key at all (no email, no linkedin, no account). The resolver's empty-key guard returns
  // masterPersonId null for a keyless probe (it does NOT mint an anonymous, un-dedupable junk identity), so the
  // backfill leaves c4's bridge NULL (in-flight staging) — and the keyless row is NON-FATAL: it never throws or
  // aborts the batch (c1/c2/c3 still resolve). Test 3 proves both: c4 stays NULL and the batch survives it.
  const [r4] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id)
    VALUES (${tenantA}, ${wsA}) RETURNING id`;
  c4 = (r4 as { id: string }).id;

  // ── Workspace B overlay fixture — the RLS-isolation control. Distinct blind index; master_person_id NULL. ─────
  const [rB] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, email_blind_index, email_domain)
    VALUES (${tenantB}, ${wsB}, ${BI3}, 'globex.com') RETURNING id`;
  cB = (rB as { id: string }).id;
}, 180_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

describe("master-link backfill (runMasterBackfill; PLAN_00 §11.5, Phase-2′ resolver)", () => {
  // The minted-person baseline BEFORE any backfill: just the one pre-seeded shared person.
  let personsBeforeRun1 = 0;
  // The minted-person count AFTER run 1 — the idempotency baseline run 2 must not move.
  let personsAfterRun1 = 0;
  // The master_person_id the dedup pair (c1/c2) resolved to in run 1.
  let resolvedPersonId: string | null = null;

  // ── TEST 1: BACKFILL RESOLVES + STAMPS ───────────────────────────────────────────────────────────────────────
  // The first pass walks workspace A's unresolved contacts, resolves each through the Phase-2′ resolver, and stamps
  // contacts.master_person_id (+ accounts.master_company_id when the contact has an account and ER resolved a
  // company). c1/c2/c3 all resolve; the Acme account gets its master_company_id stamped.
  test("backfill resolves the unresolved contacts and stamps the bridges", async () => {
    personsBeforeRun1 = await masterPersonCount();

    const result = await runMasterBackfill({ tenantId: tenantA, workspaceId: wsA });

    // At least c1, c2, c3 resolve (c4 is keyless — it may or may not resolve, but never reduces the count).
    expect(result.resolved).toBeGreaterThanOrEqual(3);

    // c1, c2, c3 now carry a non-null master_person_id.
    const [p1, p2, p3] = await Promise.all([
      masterPersonIdOf(c1),
      masterPersonIdOf(c2),
      masterPersonIdOf(c3),
    ]);
    expect(p1).toBeTruthy();
    expect(p2).toBeTruthy();
    expect(p3).toBeTruthy();
    resolvedPersonId = p1;

    // The Acme account (shared by c1 + c2) got its master_company_id stamped (the contact had an account AND ER
    // resolved a company from the 'acme.com' domain).
    const [acct] = await admin`
      SELECT master_company_id FROM accounts WHERE id = ${acmeAccount}`;
    expect((acct as { master_company_id: string | null }).master_company_id).toBeTruthy();

    personsAfterRun1 = await masterPersonCount();
  });

  // ── TEST 2: DEDUP — TWO OVERLAY COPIES, ONE GOLDEN PERSON ────────────────────────────────────────────────────
  // c1 (LINKed by linkedin 'alice') and c2 (LINKed by master_emails(BI1)) resolve to the SAME pre-seeded golden
  // person — one golden person, two overlay copies (the master-level dedup property).
  test("c1 and c2 resolve to the SAME master_person_id (dedup to one golden person)", async () => {
    const [p1, p2] = await Promise.all([masterPersonIdOf(c1), masterPersonIdOf(c2)]);
    expect(p1).toBe(p2);
    // And that shared id is exactly the pre-seeded golden person both deterministic keys point at.
    expect(p1).toBe(sharedPersonId);
  });

  // ── TEST 3: KEYLESS ROW LEFT UNRESOLVED (no junk mint) + NON-FATAL ───────────────────────────────────────────
  // c4 carries no identity key. The resolver's empty-key guard returns masterPersonId null for a keyless probe — it
  // does NOT mint an anonymous, un-dedupable junk identity — so the backfill leaves c4's bridge NULL (in-flight
  // staging). The degenerate row is also NON-FATAL: it never threw and never aborted the batch (tests 1 & 2 show
  // c1/c2/c3 all resolved around it).
  test("a keyless contact is left unresolved (no junk mint) and never aborts the batch", async () => {
    // The empty-key guard leaves c4's bridge NULL — no anonymous master was minted for it.
    expect(await masterPersonIdOf(c4)).toBeNull();
    // The other rows are unaffected by c4 — re-assert the dedup pair is intact.
    const [p1, p2] = await Promise.all([masterPersonIdOf(c1), masterPersonIdOf(c2)]);
    expect(p1).toBe(p2);
    expect(p1).toBe(sharedPersonId);
  });

  // ── TEST 4: IDEMPOTENT RE-RUN ────────────────────────────────────────────────────────────────────────────────
  // findUnresolvedForBackfill only returns master_person_id IS NULL rows. c1/c2/c3 resolved in run 1 and leave the
  // unresolved set; only the keyless c4 stays NULL (the empty-key guard never resolves it), so the re-run still
  // SCANS c4 but resolves NOTHING new and mints no duplicate golden person — the idempotency guarantee.
  test("a second backfill pass is idempotent — resolves nothing new and mints no duplicate person", async () => {
    const result = await runMasterBackfill({ tenantId: tenantA, workspaceId: wsA });

    // The re-run stamps no new person (c4 is keyless → still unresolved; everything else was resolved in run 1).
    expect(result.resolved).toBe(0);

    // No duplicate golden person was minted — the count is exactly what it was after run 1.
    expect(await masterPersonCount()).toBe(personsAfterRun1);

    // The dedup pair is still pinned to the same single golden person.
    const [p1, p2] = await Promise.all([masterPersonIdOf(c1), masterPersonIdOf(c2)]);
    expect(p1).toBe(resolvedPersonId);
    expect(p2).toBe(resolvedPersonId);
  });

  // ── TEST 5: RLS ISOLATION — wsA's backfill NEVER reads or stamps wsB's rows ──────────────────────────────────
  // runMasterBackfill reads + stamps the overlay under withTenantTx (SET LOCAL ROLE leadwolf_app + the workspace
  // GUC), so RLS scopes every overlay read/write to workspace A. wsB's contact cB — seeded with master_person_id
  // NULL — must be wholly untouched: still NULL after every wsA pass.
  test("wsB's contact is never read or stamped by wsA's backfill (RLS isolation)", async () => {
    // cB never appeared in a wsA batch, so it was never resolved/stamped — its bridge is still NULL.
    expect(await masterPersonIdOf(cB)).toBeNull();

    // A fresh wsA backfill still leaves cB untouched (defensive: prove repeated runs never cross the workspace wall).
    await runMasterBackfill({ tenantId: tenantA, workspaceId: wsA });
    expect(await masterPersonIdOf(cB)).toBeNull();

    // Sanity: the master-person count did not change either — wsA's backfill minted nothing for wsB.
    expect(await masterPersonCount()).toBe(personsAfterRun1);
  });
});
