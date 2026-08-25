// rlsCoverage.test.ts — every tenant-scoped table must be covered by an RLS policy, or be a DOCUMENTED
// exception. Static and DB-free: it reads schema/*.ts and rls/*.sql as text.
//
// WHY THIS EXISTS. The isolation itests prove that the policies which EXIST work — crmIsolation, emailIsolation
// and their siblings each pick a table and show the wrong scope sees nothing. Nothing proved the set was
// COMPLETE. Add a table with a `tenant_id` column and forget its policy file, and every one of those itests
// still passes: they assert about the tables they name, and the new one is not named anywhere. The failure is
// silent and the exposure is total — `leadwolf_app` reads it cross-tenant.
//
// That is the one gap this repo can least afford (CLAUDE.md: "A multi-tenant write without an RLS-enforced,
// ownership-checked path is a bug, not a style choice"), and it needed no database to close: the schema
// declares the tenancy column and the rls/ directory declares the policy, so the two lists can simply be
// compared. It runs on every commit, on a laptop, in milliseconds — which matters because the alternative
// (an itest) cannot run on a host without Docker, and this repo has one.
//
// THE FORMER LIMITATION, CLOSED 2026-08-22. This guard used to read only `pgTable`, so a table created by
// hand-authored migration SQL with no Drizzle definition was invisible to it — and the header said so, which
// is not the same as checking. The second describe block below reads the MIGRATIONS instead, so a tenant-keyed
// table that exists only as SQL now has to be policied, REVOKE'd, or listed above with a reason. That the gap
// was real is not hypothetical: migration 0097's contribution-control tables had no pgTable at all until one
// was added later, and `contributionControls.test.ts` exists to pin those definitions against the SQL.
//
// Verified by mutation rather than assumed: a throwaway migration declaring `probe_leaky_table (tenant_id
// uuid …)` with no policy fails the new check by name, and removing it returns the file to green.
//
// RE-MEASURED 2026-08-22 (the previous census was 13 Aug and predates migrations 0108–0139). Of 151 tables
// created in the `public` schema across the migration chain, 151 have a pgTable and 2 do not:
//   • platform_audit_log — tenant-keyed, and the ONLY hand-authored table that is. Not policied on purpose:
//     applyMigrations REVOKEs it from leadwolf_app outright, alongside platform_staff, impersonation_sessions,
//     jit_elevations, support_notes, account_holds, announcements and retention_policies. A revoke is the
//     stronger posture — the role cannot address the table at all — and rls/platform.sql denies it as well.
//   • master_market_rollups (0130) — a Layer-0 non-PII aggregate cache with NO tenant key, so there is no
//     predicate to write. Correctly outside RLS; it is in this census so the absence is recorded rather than
//     assumed.
// Excluded from the count by shape, each for a stated reason asserted below: `forge.*` and `er.*` (isolated
// by schema + a dedicated role, ADR-0047 — the wrong mechanism to demand a policy for) and partition children
// (`CREATE TABLE … PARTITION OF …`, which inherit the parent ACL via mirror_partition_acl, 0102).

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_DIR = join(import.meta.dir, "schema");
const RLS_DIR = join(import.meta.dir, "rls");

/**
 * Tables that are tenant-scoped yet deliberately carry NO policy. Each needs a reason, and the reason has to
 * be a posture the codebase actually implements — not an intention.
 */
const DOCUMENTED_EXCEPTIONS: Readonly<Record<string, string>> = {
  // Platform-owned staff data: RLS is not the mechanism — `applyMigrations` REVOKEs the table from
  // leadwolf_app outright, so the customer role cannot address it at all. A policy would be weaker.
  account_holds: "platform-owned; REVOKE ALL FROM leadwolf_app in applyMigrations",
  support_notes: "platform-owned; REVOKE ALL FROM leadwolf_app in applyMigrations",
  // A KNOWN, documented gap — audit 32 §9.3-1. applyMigrations says it plainly: user_sessions "deliberately
  // KEEPS the grant" because the workspace-admin session path reads it via withTenantTx bounded by a
  // workspace_members join, and "its no-RLS gap (a RAW query bypasses the join) wants an RLS policy rather
  // than a revoke — a separate follow-up". Listed here so it stays VISIBLE and countable rather than
  // dissolving into the 82 tables that are fine.
  //
  // THE PREDICTED HAZARD HAS NOW HAPPENED ONCE (2026-08-25). "A raw query bypasses the join" was written as a
  // possibility; `sessionRepository.revokeInTx` was an instance of it — an UPDATE keyed on the session id
  // alone, with no workspace predicate and no RLS underneath, safe only because its single caller happened to
  // call findActiveInWorkspace first. Now scoped by workspaceId and pinned by an itest. A second comment in
  // that same feature claimed the read was "RLS-scoped", i.e. asserted the opposite of this register; also
  // corrected. The gap itself is unchanged and still wants the policy — see decisions.md #10 — but it is no
  // longer only theoretical, which is the part worth knowing when it is prioritised.
  user_sessions: "audit 32 §9.3-1 — known gap, wants a policy (not a revoke); see applyMigrations",
};

function readDir(dir: string, ext: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => readFileSync(join(dir, f), "utf8"));
}

/** SQL table names declared with `pgTable("name", …)`, mapped to the body of that declaration. */
function declaredTables(): Map<string, string> {
  const out = new Map<string, string>();
  for (const src of readDir(SCHEMA_DIR, ".ts")) {
    const marks: Array<[number, string]> = [];
    for (const m of src.matchAll(/pgTable\(\s*"([a-z0-9_]+)"/gi)) {
      marks.push([m.index ?? 0, m[1] as string]);
    }
    marks.forEach(([pos, name], i) => {
      const end = i + 1 < marks.length ? (marks[i + 1] as [number, string])[0] : src.length;
      out.set(name, src.slice(pos, end));
    });
  }
  return out;
}

/** Tables carrying a tenant key — the ones an RLS predicate can and must be written against. */
function tenantScopedTables(): string[] {
  const out: string[] = [];
  for (const [name, body] of declaredTables()) {
    if (/\btenantId\(\)|"tenant_id"/.test(body)) out.push(name);
  }
  return out.sort();
}

/** Tables named by a `CREATE POLICY … ON <table>` anywhere in rls/. */
function tablesWithPolicy(): Set<string> {
  const out = new Set<string>();
  for (const src of readDir(RLS_DIR, ".sql")) {
    for (const m of src.matchAll(/CREATE\s+POLICY\s+\S+\s+ON\s+([a-z0-9_.]+)/gi)) {
      out.add((m[1] as string).split(".").pop() as string);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// The blind spot above, closed. Everything from here reads the MIGRATIONS rather than the Drizzle schema, so
// a table that exists only as hand-authored SQL is visible — the case the header calls out as real but
// currently empty of defects. It stays empty only if something checks.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const APPLY_MIGRATIONS = join(import.meta.dir, "applyMigrations.ts");

/** Words that follow `CREATE TABLE` without being a table name. */
const NOT_A_NAME = new Set(["if", "not", "exists"]);

/** Every `CREATE TABLE` in the migration chain, mapped to its column body (balanced-paren scan). */
function migrationTables(): Map<string, string> {
  const out = new Map<string, string>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_."]+)\s*\(/gi;
    let match: RegExpExecArray | null = re.exec(sql);
    while (match !== null) {
      const name = (match[1] as string).replace(/"/g, "").replace(/^public\./, "");
      const bare = name.split(".").pop() as string;
      // Skip anything still schema-qualified after `public.` is stripped — i.e. `forge.*` and `er.*`. Those
      // planes are isolated by SCHEMA plus a dedicated role (ADR-0047), deliberately not by RLS, so demanding
      // a policy for them would be demanding the wrong mechanism. Dropping the prefix instead of skipping is
      // what made this scan first report `forge.contributor` as an uncovered tenant table.
      if (!name.includes(".") && !NOT_A_NAME.has(bare.toLowerCase())) {
        // Walk to the matching close paren so the body is the column list, not the rest of the file.
        let depth = 1;
        let i = re.lastIndex;
        while (i < sql.length && depth > 0) {
          const c = sql[i];
          if (c === "(") depth += 1;
          else if (c === ")") depth -= 1;
          i += 1;
        }
        if (!out.has(bare)) out.set(bare, sql.slice(re.lastIndex, i));
      }
      match = re.exec(sql);
    }
  }
  return out;
}

/** Tables the app role is REVOKE'd from in applyMigrations — a stronger posture than a policy, not a weaker
 *  one: the role cannot address the table at all. */
function revokedFromAppRole(): Set<string> {
  const src = readFileSync(APPLY_MIGRATIONS, "utf8");
  const out = new Set<string>();
  for (const m of src.matchAll(/REVOKE\s+ALL\s+ON\s+([a-z0-9_]+)\s+FROM\s+leadwolf_app/gi)) {
    out.add(m[1] as string);
  }
  return out;
}

describe("RLS covers every tenant-scoped table", () => {
  test("the scan finds a realistic number of tables (guards against matching nothing)", () => {
    // If the schema layout changes and these regexes stop matching, every assertion below passes vacuously.
    // This is the floor that makes the rest of the file mean something.
    expect(declaredTables().size).toBeGreaterThan(100);
    expect(tenantScopedTables().length).toBeGreaterThan(70);
    expect(tablesWithPolicy().size).toBeGreaterThan(70);
  });

  test("no tenant-scoped table is missing a policy without a documented reason", () => {
    const policied = tablesWithPolicy();
    const uncovered = tenantScopedTables().filter(
      (t) => !policied.has(t) && !(t in DOCUMENTED_EXCEPTIONS),
    );

    // If this fails you have added a table with a tenant_id and no `CREATE POLICY` for it. leadwolf_app can
    // read it ACROSS TENANTS. Write the policy in packages/db/src/rls/, or — if the table is platform-owned —
    // REVOKE it in applyMigrations and add it above with its reason.
    expect(uncovered).toEqual([]);
  });

  test("every documented exception is still tenant-scoped and still policy-free", () => {
    // Keeps the exception list honest in both directions: an entry that gains a policy, or stops being
    // tenant-scoped, is stale and should be deleted rather than left implying a gap that no longer exists.
    const tenantScoped = new Set(tenantScopedTables());
    const policied = tablesWithPolicy();
    for (const name of Object.keys(DOCUMENTED_EXCEPTIONS)) {
      expect(tenantScoped.has(name)).toBe(true);
      expect(policied.has(name)).toBe(false);
    }
  });

  test("the exception list stays small — it is a ledger of gaps, not a parking bay", () => {
    expect(Object.keys(DOCUMENTED_EXCEPTIONS).length).toBeLessThanOrEqual(3);
  });
});

describe("RLS covers hand-authored tables too (the pgTable blind spot)", () => {
  test("the migration scan finds a realistic number of tables", () => {
    // Same floor logic as above: a regex that silently stopped matching would make every assertion below
    // pass on an empty set, which is the only way this check can lie.
    expect(migrationTables().size).toBeGreaterThan(100);
    expect(revokedFromAppRole().size).toBeGreaterThan(3);
  });

  test("every tenant-keyed table WITHOUT a pgTable is either policied or revoked", () => {
    const drizzle = new Set(declaredTables().keys());
    const policied = tablesWithPolicy();
    const revoked = revokedFromAppRole();

    const unexplained: string[] = [];
    for (const [name, body] of migrationTables()) {
      if (drizzle.has(name)) continue; // covered by the assertions above
      if (!/\btenant_id\b|\bworkspace_id\b/.test(body)) continue; // Layer-0 / platform: no tenant key to scope
      if (policied.has(name) || revoked.has(name) || name in DOCUMENTED_EXCEPTIONS) continue;
      unexplained.push(name);
    }

    // If this fails, a table with a tenant key exists ONLY as hand-authored SQL, has no policy and is not
    // revoked — so leadwolf_app reads it across tenants and nothing else in this file can see it. Give it a
    // pgTable and a policy (the schema barrel wants the pgTable anyway), or REVOKE it if platform-owned.
    expect(unexplained.sort()).toEqual([]);
  });

  test("partition CHILDREN are excluded by shape, and every one has a known parent", () => {
    // Children are declared `CREATE TABLE x_default PARTITION OF x DEFAULT` — no column list — so the
    // balanced-paren scan above never sees them, which is the correct outcome for the wrong-looking reason.
    // They inherit the parent's ACL via mirror_partition_acl (0102) and carry the parent's tenant_id, so
    // demanding a policy of them would demand one that must not exist. Asserted here so the exclusion is a
    // stated rule rather than a lucky property of the regex.
    const sql = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
      .join("\n");

    const children = [
      ...sql.matchAll(/CREATE\s+TABLE\s+([a-z0-9_]+)\s+PARTITION\s+OF\s+([a-z0-9_]+)/gi),
    ];
    expect(children.length).toBeGreaterThan(0);

    const scanned = migrationTables();
    const drizzle = declaredTables();
    for (const match of children) {
      const child = match[1] as string;
      const parent = match[2] as string;
      expect(scanned.has(child)).toBe(false); // never scanned as a table in its own right
      expect(scanned.has(parent) || drizzle.has(parent)).toBe(true); // and the parent IS known
    }
  });
});
