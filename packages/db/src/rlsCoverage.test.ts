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
