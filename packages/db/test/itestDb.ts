// itestDb.ts — provision the integration-test Postgres: Testcontainers (postgres:16) by default, or an
// EXTERNAL server via ITEST_DATABASE_URL for environments without Docker (CI service containers, local
// clusters). External mode creates one isolated database per call so itest files never collide; both modes
// hand back the admin URL plus the non-BYPASSRLS leadwolf_app URL the RLS proofs connect with.
//
// External mode clones each per-file database from a MIGRATED TEMPLATE (built once per server, advisory-
// lock coordinated, keyed by the migration/rls file set): running the full migration chain per file cost
// ~3 minutes × 91 files and was the reason every CI itest job died at its timeout. The per-file
// applyMigrations() call the tests still make is a fast no-op on a clone — the drizzle journal is cloned
// with the database, and the role/rls/grant steps are idempotent.

// ── THE SHAPE AN ISOLATION PROOF MUST HAVE ────────────────────────────────────────────────────────────────
// A test whose only assertion is "the wrong scope sees zero rows" proves nothing on its own: it passes when
// RLS works, and equally when the seed never wrote the row, when the predicate is wrong, or when a GUC the
// policy needs was never set. Those are indistinguishable from `expect(n).toBe(0)`.
//
// So every isolation proof pairs its zero with a POSITIVE CONTROL — the right scope sees 1 — either in the
// same test or in an adjacent one (crmIsolation's "workspace A does read its own ciphertext (the read path
// works at all)" is the canonical example of the sibling form; both shapes are fine).
//
// Swept 13 Aug 2026: 647 test blocks across packages/db/test/*.itest.ts, 38 asserted only emptiness. Most are
// legitimately negative — "an unknown slug resolves to null", "a second consume returns null", a 42501 REVOKE
// proof — where the null IS the behaviour under test and there is nothing to control for. Every
// isolation-critical one had its control, in-block or sibling, except email_event in emailIsolation, which
// was fixed. Re-run that reasoning if you add one; a zero without a control is the easiest vacuous test to
// write and the hardest to notice, because it is green from the day it stops meaning anything.

import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export interface ItestDb {
  adminUrl: string;
  appUrl: string;
  stop(): Promise<void>;
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

function appUrlFrom(adminUrl: string): string {
  const u = new URL(adminUrl);
  u.username = "leadwolf_app";
  // Must match the password applyMigrations sets for leadwolf_app (its DEFAULT_APP_ROLE_PASSWORD) when the
  // itests call applyMigrations() with no appRolePassword override — otherwise the RLS proofs fail to auth.
  u.password = "Lw_App_Role_2026!x7Qm";
  return u.toString();
}

/** Stable key for the template DB: the migration + rls file NAMES (a new/renamed file = new template). */
function migrationSetHash(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const names: string[] = [];
  for (const dir of ["../src/migrations", "../src/rls"]) {
    try {
      for (const f of readdirSync(join(here, dir))) {
        if (f.endsWith(".sql")) names.push(`${dir}/${f}`);
      }
    } catch {
      // dir absent in some layouts — the hash just covers what exists
    }
  }
  return createHash("sha256").update(names.sort().join("\n")).digest("hex").slice(0, 12);
}

/** Build (once per server) the fully-migrated template database and return its name. */
async function ensureTemplate(external: string, root: postgres.Sql): Promise<string> {
  const tmpl = `itest_tmpl_${migrationSetHash()}`;
  // Serialize builders across processes on this server; same-name check-then-create stays race-free.
  await root.unsafe("SELECT pg_advisory_lock(727271)");
  try {
    const exists = await root`SELECT 1 AS ok FROM pg_database WHERE datname = ${tmpl}`;
    if (exists.length === 0) {
      await root.unsafe(`CREATE DATABASE "${tmpl}"`);
      const { applyMigrations } = await import("../src/applyMigrations.ts");
      await applyMigrations(withDatabase(external, tmpl));
    }
  } finally {
    await root.unsafe("SELECT pg_advisory_unlock(727271)");
  }
  return tmpl;
}

export async function startItestDb(name: string): Promise<ItestDb> {
  const external = process.env.ITEST_DATABASE_URL;
  if (external) {
    const database = `itest_${name}_${Date.now().toString(36)}`;
    const root = postgres(external, { max: 1, onnotice: () => {} });
    const tmpl = await ensureTemplate(external, root);
    // Quote the identifier: an uppercase name (e.g. "workspaceSwitch") is otherwise folded to lowercase by
    // CREATE DATABASE while the connection URL keeps the original case -> "database does not exist".
    await root.unsafe(`CREATE DATABASE "${database}" TEMPLATE "${tmpl}"`);
    await root.end();
    const adminUrl = withDatabase(external, database);
    return {
      adminUrl,
      appUrl: appUrlFrom(adminUrl),
      stop: async () => {
        const cleaner = postgres(external, { max: 1, onnotice: () => {} });
        await cleaner.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        await cleaner.end();
      },
    };
  }

  // Default: throwaway container (requires Docker). Imported lazily so external mode never touches it.
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container = await new PostgreSqlContainer("postgres:16")
    .withUsername("leadwolf")
    .withPassword("leadwolf")
    .withDatabase("leadwolf")
    .start();
  const adminUrl = container.getConnectionUri();
  return {
    adminUrl,
    appUrl: appUrlFrom(adminUrl),
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * The single row a query is expected to return.
 *
 * The itests are full of `const [r] = await sql\`…\`` followed by `r.foo`, which asserts "this returned a row"
 * without saying so — TypeScript flags it, and at run time a genuinely empty result fails three lines later
 * with "Cannot read properties of undefined", naming a variable rather than the query that came back empty.
 * This says it once, and says which query when it happens.
 */
export function one<T>(rows: readonly T[], what = "row"): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error(`itest: expected exactly one ${what}, got ${rows.length}`);
  }
  return first;
}
