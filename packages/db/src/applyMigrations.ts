// applyMigrations.ts — the reusable migration routine shared by the CLI (migrate.ts) and the integration
// tests. Three idempotent phases against a given connection string: bootstrap (extensions, uuid_generate_v7,
// the non-BYPASSRLS leadwolf_app role) → drizzle-generated table migrations → every src/rls/*.sql
// (policies + triggers). Takes the connection string as an argument so it has no dependency on @leadwolf/config.

import { writeSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "migrations");
const rlsFolder = join(here, "rls");

// leadwolf_app login password: the app connects AS leadwolf_app (RLS-enforced), so this is its real login
// secret — override via DATABASE_APP_ROLE_PASSWORD in production. Managed Postgres (Neon) rejects weak
// passwords on CREATE ROLE, so the default is strong. leadwolf_admin is NOLOGIN (reached only via SET ROLE
// by the owner for the audited DSAR/admin path) — it needs no password and cannot be logged into directly.
const DEFAULT_APP_ROLE_PASSWORD = "Lw_App_Role_2026!x7Qm";

const bootstrap = (appPwd: string): string => `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS citext;

  CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid AS $$
    SELECT encode(
      set_bit(set_bit(
        overlay(uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6),
        52, 1), 53, 1), 'hex')::uuid;
  $$ LANGUAGE sql VOLATILE;

  DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'leadwolf_app') THEN
      CREATE ROLE leadwolf_app LOGIN PASSWORD '${appPwd}';
    END IF;
    -- The privileged cross-tenant role (03 §9, ADR-0011): BYPASSRLS, used ONLY by the audited DSAR path
    -- (and later apps/admin). Authored at M0 per the plan; first wired at M5.
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'leadwolf_admin') THEN
      CREATE ROLE leadwolf_admin NOLOGIN;
    END IF;
    -- BYPASSRLS can only be granted by a superuser (local Docker / RDS). Managed Postgres such as Neon
    -- disallows it for the owner role, so apply it only when the connecting role is itself a superuser.
    -- leadwolf_admin is exercised solely by the audited DSAR path (first wired at M5), so a non-BYPASSRLS
    -- role is the correct, safe fallback wherever the attribute cannot be granted.
    IF (SELECT rolsuper FROM pg_roles WHERE rolname = CURRENT_USER) THEN
      ALTER ROLE leadwolf_admin BYPASSRLS;
    END IF;
  END $$;
  GRANT USAGE ON SCHEMA public TO leadwolf_app;
  GRANT USAGE ON SCHEMA public TO leadwolf_admin;
  -- Let the connecting base/owner role SET LOCAL ROLE into both app roles (no-op for superusers; required
  -- for a non-superuser owner in production).
  GRANT leadwolf_app TO CURRENT_USER;
  GRANT leadwolf_admin TO CURRENT_USER;
`;

// Table/sequence privileges for the app role, applied AFTER tables exist (RLS still gates which rows it sees).
const GRANTS = `
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO leadwolf_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO leadwolf_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO leadwolf_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO leadwolf_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO leadwolf_admin;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO leadwolf_admin;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO leadwolf_admin;
  -- platform_audit_log is the staff cross-tenant audit trail (ADR-0032): the customer app role must have NO
  -- access. RLS (rls/platform.sql) already denies it every row, but the blanket grant above also handed it
  -- table privileges — REVOKE them so leadwolf_app cannot read or tamper the audit trail even if a policy
  -- were later added by mistake. The owner/withPlatformTx writer is unaffected (it is the table owner).
  REVOKE ALL ON platform_audit_log FROM leadwolf_app;
  -- platform_staff (ADR-0011) is platform-owned the same way — the app role must not read who operates the
  -- platform. RLS denies it; REVOKE the blanket grant too. The owner connection (requireStaffRole lookup +
  -- grant/revoke writes) is unaffected.
  REVOKE ALL ON platform_staff FROM leadwolf_app;
`;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function applyMigrations(
  connectionString: string,
  opts: { appRolePassword?: string; adminRolePassword?: string } = {},
): Promise<void> {
  // Single-quote-escape so a password containing ' can't break the bootstrap SQL.
  const appPwd = (opts.appRolePassword ?? DEFAULT_APP_ROLE_PASSWORD).replace(/'/g, "''");
  // `prepare: false` is REQUIRED here: Drizzle's migrator issues prepared statements, which a
  // transaction-pooling proxy (Neon `-pooler` / PgBouncer / RDS Proxy) can't keep across checkouts —
  // the classic "migration hangs forever" on Neon's default pooled host. Mirrors client.ts. The timeouts
  // turn every other freeze mode (unreachable host, blocked lock) into a fast error instead of an
  // indefinite wait. `statement_timeout` is deliberately generous: first-run DDL can be legitimately slow.
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 15,
    onnotice: () => {},
    connection: {
      lock_timeout: 15000,
      statement_timeout: 120000,
    },
  });
  const db = drizzle(sql);
  // Per-phase progress so the run is never a silent black box — on a managed DB (Neon) the DDL is many
  // network round-trips and can take tens of seconds; without this it looks "frozen" when it's just working.
  // Progress via writeSync(fd 2) — a DIRECT synchronous write to stderr that cannot be buffered. Bun (like
  // Node) buffers process.stdout/stderr.write when the stream is a pipe (the case under `docker compose run`,
  // non-TTY), so those would stay invisible until the process exits — making a working migration look frozen.
  // writeSync goes straight to the fd, so each phase appears live regardless of TTY/pipe.
  const log = (m: string): void => {
    writeSync(2, m);
  };
  try {
    log("migrate: [1/4] bootstrap (extensions, roles, uuid_generate_v7)…\n");
    await sql.unsafe(bootstrap(appPwd));
    if (await exists(migrationsFolder)) {
      log("migrate: [2/4] applying table migrations…\n");
      await migrate(db, { migrationsFolder });
    } else {
      log(
        `migrate: WARNING no migrations at ${migrationsFolder} — run \`drizzle-kit generate\` first.\n`,
      );
    }
    const files = (await readdir(rlsFolder)).filter((f) => f.endsWith(".sql")).sort();
    log(`migrate: [3/4] applying ${files.length} RLS policy file(s)…\n`);
    for (const file of files) {
      log(`migrate:        → ${file}\n`);
      await sql.unsafe(await readFile(join(rlsFolder, file), "utf8"));
    }
    // Grant the non-BYPASSRLS app role access to the now-created tables/sequences (RLS still gates rows).
    log("migrate: [4/4] grants…\n");
    await sql.unsafe(GRANTS);
  } finally {
    await sql.end();
  }
}
