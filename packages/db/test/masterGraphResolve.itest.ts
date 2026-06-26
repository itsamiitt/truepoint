// masterGraphResolve.itest.ts — the behavioural proof of the co-op-safe MATCH-AGAINST resolver
// (masterGraphRepository.resolveForImport; ADR-0021; prospect-company-data PLAN_01 §4/§5.3, Phase 2′). Where
// masterGraphIsolation.itest.ts proves the GRANT-OFF WALL (who may touch Layer 0), THIS file proves WHAT the
// resolver may write when it does: a clean miss MINTs only non-revealable identity + dedup keys, a deterministic
// hit LINKs and mutates NOTHING, and MATCH-AGAINST contributes no PII profile and no provenance. On a real
// Postgres 16 (Testcontainers by default, or an external server via ITEST_DATABASE_URL — see itestDb.ts). Run in
// its OWN process (the db client is a module singleton): `bun test ./packages/db/test/masterGraphResolve.itest.ts`.
//
// Resolution runs under dbmod.withErTx (SET LOCAL ROLE leadwolf_er — the least-privilege, NON-BYPASSRLS Layer-0
// role). The master tables are system-owned (no workspace_id, no RLS, no leadwolf_app grant), so they are
// seeded/asserted via the privileged `admin` (owner) connection — leadwolf_app cannot read them at all. The proofs:
//   1. Co-op-safe MINT (central) — a clean miss writes identity + blind-index dedup keys ONLY: master_persons with
//      NULL name/title/department + has_email=false, master_companies (domain+name), master_emails with the blind
//      index but email_enc IS NULL (the revealable value was NOT contributed), a bare master_employment edge, and
//      ZERO source_records/match_links + field_provenance '{}' (MATCH-AGAINST writes no provenance).
//   2. Dedup by email — a re-resolve on the same blind index LINKs the same person and contributes nothing.
//   3. Dedup by linkedin — a re-resolve on the same linkedin_public_id LINKs the same person.
//   4. Company dedup + company-less — same registrable domain → same company; no domain → masterCompanyId null.
//   5. The wall still holds with the er grant — leadwolf_er reads master_persons; leadwolf_app is still denied 42501.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

// Postgres "insufficient_privilege" — the proof the wall is grant-off (a denied SELECT), not an RLS row filter.
const PERMISSION_DENIED = "42501";

// A fixed email blind index — it is just an opaque HMAC dedup key for these tests, never decoded.
const BI = new Uint8Array([1, 2, 3, 4]);

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let dbmod: DbModule;

// Carried across tests: the ids minted in test 1, re-asserted as the LINK targets in tests 2–4.
let personId = "";
let companyId = "";

beforeAll(async () => {
  dbHandle = await startItestDb("masterGraphResolve");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  // admin = the privileged owner/bypass connection used for ALL Layer-0 assertions (leadwolf_app has no master
  // grant); app = the non-BYPASSRLS leadwolf_app role used only to prove the wall still denies it in test 5.
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });

  // env is set above, BEFORE the db singleton loads.
  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

describe("co-op-safe MATCH-AGAINST resolveForImport (Phase 2′; ADR-0021, PLAN_01 §5.3)", () => {
  // ── TEST 1: THE CO-OP-SAFE MINT (the central proof) ─────────────────────────────────────────────────────────
  // A clean miss mints a golden pair from identity + dedup keys ONLY — never a revealable value or a contributed
  // PII profile field, never a provenance row. This is the security boundary that lets a non-co-op import resolve
  // AGAINST the shared graph without leaking its PII to other workspaces (PLAN_01 §5.3).
  test("clean miss MINTs identity + dedup only: NULL PII, email_enc NULL, bare edge, zero provenance", async () => {
    const result = await dbmod.withErTx((tx) =>
      dbmod.masterGraphRepository.resolveForImport(tx, {
        linkedinPublicId: "jane-doe",
        emailBlindIndex: BI,
        emailDomain: "acme.com",
        registrableDomain: "acme.com",
        companyName: "Acme Inc",
      }),
    );
    expect(result.masterPersonId).toBeTruthy();
    expect(result.masterCompanyId).toBeTruthy();
    personId = result.masterPersonId;
    companyId = result.masterCompanyId as string;

    // (a) master_persons — the golden person carries ONLY identity + the denormalized company pointer; every PII
    //     profile VALUE (name parts, title, department) is NULL and has_email is false (a blind index is a dedup
    //     key, not a contributed channel value). This is the co-op-safe person posture.
    const [mp] = await admin`
      SELECT linkedin_public_id, current_company_id, has_email, has_phone,
             full_name, first_name, last_name, job_title, department, field_provenance
        FROM master_persons WHERE id = ${personId}`;
    const person = mp as {
      linkedin_public_id: string;
      current_company_id: string;
      has_email: boolean;
      has_phone: boolean;
      full_name: string | null;
      first_name: string | null;
      last_name: string | null;
      job_title: string | null;
      department: string | null;
      field_provenance: Record<string, unknown>;
    };
    expect(person.linkedin_public_id).toBe("jane-doe");
    expect(person.current_company_id).toBe(companyId);
    expect(person.has_email).toBe(false);
    expect(person.has_phone).toBe(false);
    // No PII profile contributed — every revealable person field stays NULL (overlay-only).
    expect(person.full_name).toBeNull();
    expect(person.first_name).toBeNull();
    expect(person.last_name).toBeNull();
    expect(person.job_title).toBeNull();
    expect(person.department).toBeNull();
    // MATCH-AGAINST writes no provenance — the C6 map is the default empty object.
    expect(person.field_provenance).toEqual({});

    // (b) master_companies — the minted company carries the registrable domain + the display name only.
    const [mc] = await admin`
      SELECT primary_domain, name FROM master_companies WHERE id = ${companyId}`;
    const company = mc as { primary_domain: string; name: string };
    expect(company.primary_domain).toBe("acme.com");
    expect(company.name).toBe("Acme Inc");

    // (c) master_emails — THE co-op-safe proof: the blind-index dedup key + the public domain facet are stored,
    //     but email_enc IS NULL (the revealable value was NOT contributed; only a paid/opt-in source contributes it).
    const [me] = await admin`
      SELECT master_person_id, email_enc, email_domain
        FROM master_emails WHERE email_blind_index = ${BI}`;
    const email = me as {
      master_person_id: string;
      email_enc: Uint8Array | null;
      email_domain: string;
    };
    expect(email.master_person_id).toBe(personId);
    expect(email.email_enc).toBeNull();
    expect(email.email_domain).toBe("acme.com");

    // (d) master_employment — a single BARE edge (is_current + is_primary true) with NO title/department.
    const [edge] = await admin`
      SELECT is_current, is_primary, title, department
        FROM master_employment
       WHERE master_person_id = ${personId} AND master_company_id = ${companyId}`;
    const employment = edge as {
      is_current: boolean;
      is_primary: boolean;
      title: string | null;
      department: string | null;
    };
    expect(employment.is_current).toBe(true);
    expect(employment.is_primary).toBe(true);
    expect(employment.title).toBeNull();
    expect(employment.department).toBeNull();

    // (e) ZERO provenance artifacts — MATCH-AGAINST writes no source_records and no match_links (those are the
    //     opt-in CONTRIBUTE-TO path's job), and the person's field_provenance map is empty (asserted in (a)).
    const [sr] = await admin`SELECT count(*)::int AS n FROM source_records`;
    expect((sr as { n: number }).n).toBe(0);
    const [ml] = await admin`SELECT count(*)::int AS n FROM match_links`;
    expect((ml as { n: number }).n).toBe(0);
  });

  // ── TEST 2: DEDUP BY EMAIL — LINK, mutate nothing ──────────────────────────────────────────────────────────
  // Re-resolving with the SAME email blind index but a DIFFERENT linkedin/company must LINK to the same person and
  // contribute nothing — a LINK is a pure read + return (PLAN_01 §5.3). The differing keys must NOT overwrite the
  // golden row (no PII suddenly appears, no second person is minted).
  test("dedup by email LINKs the same person and contributes nothing", async () => {
    const [before] = await admin`SELECT count(*)::int AS n FROM master_persons`;
    const personsBefore = (before as { n: number }).n;

    const result = await dbmod.withErTx((tx) =>
      dbmod.masterGraphRepository.resolveForImport(tx, {
        linkedinPublicId: "someone-else", // different — must NOT relink or overwrite
        emailBlindIndex: BI, // same dedup key → LINK to the test-1 person
        emailDomain: "acme.com",
        registrableDomain: "acme.com",
        companyName: "Totally Different Name", // must NOT rename the company
      }),
    );
    expect(result.masterPersonId).toBe(personId);

    // No second mint — the person count is unchanged.
    const [after] = await admin`SELECT count(*)::int AS n FROM master_persons`;
    expect((after as { n: number }).n).toBe(personsBefore);

    // A LINK contributed nothing — the golden person still carries NO PII profile.
    const [mp] = await admin`
      SELECT full_name, first_name, last_name, job_title FROM master_persons WHERE id = ${personId}`;
    const person = mp as {
      full_name: string | null;
      first_name: string | null;
      last_name: string | null;
      job_title: string | null;
    };
    expect(person.full_name).toBeNull();
    expect(person.first_name).toBeNull();
    expect(person.last_name).toBeNull();
    expect(person.job_title).toBeNull();
  });

  // ── TEST 3: DEDUP BY LINKEDIN ──────────────────────────────────────────────────────────────────────────────
  // The linkedin_public_id is the strongest person key. A probe carrying it (and no email) LINKs to the same person.
  test("dedup by linkedin_public_id LINKs the same person", async () => {
    const result = await dbmod.withErTx((tx) =>
      dbmod.masterGraphRepository.resolveForImport(tx, {
        linkedinPublicId: "jane-doe", // same strongest key → LINK
        registrableDomain: "acme.com",
        companyName: "Acme Inc",
      }),
    );
    expect(result.masterPersonId).toBe(personId);
  });

  // ── TEST 4: COMPANY DEDUP + COMPANY-LESS ───────────────────────────────────────────────────────────────────
  // The registrable domain is the company dedup key: the same domain LINKs the same company (no second mint). With
  // NO registrable domain the resolver mints a company-less person (masterCompanyId null) — a company mint REQUIRES
  // a domain (the free-mail guard lives in the caller; a domainless signal never fabricates a company).
  test("same domain LINKs the same company; no domain → company-less (null)", async () => {
    const [before] = await admin`SELECT count(*)::int AS n FROM master_companies`;
    const companiesBefore = (before as { n: number }).n;

    // Same registrable domain → same company id, no second company minted.
    const linked = await dbmod.withErTx((tx) =>
      dbmod.masterGraphRepository.resolveForImport(tx, {
        linkedinPublicId: "another-person",
        registrableDomain: "acme.com",
        companyName: "Acme Inc",
      }),
    );
    expect(linked.masterCompanyId).toBe(companyId);

    const [after] = await admin`SELECT count(*)::int AS n FROM master_companies`;
    expect((after as { n: number }).n).toBe(companiesBefore);

    // No registrable domain → company-less person (a company mint requires a domain).
    const companyLess = await dbmod.withErTx((tx) =>
      dbmod.masterGraphRepository.resolveForImport(tx, {
        linkedinPublicId: "no-company-person",
      }),
    );
    expect(companyLess.masterPersonId).toBeTruthy();
    expect(companyLess.masterCompanyId).toBeNull();
  });

  // ── TEST 5: THE WALL HOLDS WITH THE ER GRANT ───────────────────────────────────────────────────────────────
  // leadwolf_er can READ the master graph (it must, to resolve) — but the new er grant must NOT have widened
  // leadwolf_app's access. A withErTx SELECT on master_persons succeeds; a leadwolf_app SELECT still throws 42501.
  test("leadwolf_er reads master_persons; leadwolf_app is still denied 42501", async () => {
    // leadwolf_er can read the master graph.
    const erCount = await dbmod.withErTx(async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM master_persons`,
      )) as unknown as Array<{ n: number }>;
      return rows[0]!.n;
    });
    expect(erCount).toBeGreaterThan(0);

    // leadwolf_app is still walled off — a SELECT on master_persons is permission-denied (the grant-off wall holds).
    let appCode = "";
    try {
      await app.begin(async (tx) => {
        await tx`SELECT * FROM master_persons LIMIT 1`;
      });
    } catch (e) {
      appCode = (e as { code?: string }).code ?? "";
    }
    expect(appCode).toBe(PERMISSION_DENIED);
  });
});
