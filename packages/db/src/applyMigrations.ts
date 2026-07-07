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
    -- The least-privilege Layer-0 resolution role (ADR-0021 MATCH-AGAINST; prospect-company-data PLAN_01 §4):
    -- NOLOGIN, NON-BYPASSRLS — it reads the master graph and writes only co-op-safe mints (no overlay grant,
    -- never BYPASSRLS). Reached only via withErTx (SET LOCAL ROLE). Created idempotently like leadwolf_admin.
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'leadwolf_er') THEN
      CREATE ROLE leadwolf_er NOLOGIN;
    END IF;
    -- The TruePoint Forge data-plane role (ADR-0047; nested-repo firewall): NOLOGIN, NON-BYPASSRLS — it owns
    -- ONLY the forge schema (raw to parsed to verified + ER/governance) and has NO grant on the public/overlay
    -- tables, so the ingest-to-verify pipeline can never read a customer's contacts. Reached only via withForgeTx.
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'leadwolf_forge') THEN
      CREATE ROLE leadwolf_forge NOLOGIN;
    END IF;
  END $$;
  GRANT USAGE ON SCHEMA public TO leadwolf_app;
  GRANT USAGE ON SCHEMA public TO leadwolf_admin;
  GRANT USAGE ON SCHEMA public TO leadwolf_er;
  -- Let the connecting base/owner role SET LOCAL ROLE into all three app roles (no-op for superusers; required
  -- for a non-superuser owner in production).
  GRANT leadwolf_app TO CURRENT_USER;
  GRANT leadwolf_admin TO CURRENT_USER;
  GRANT leadwolf_er TO CURRENT_USER;
  GRANT leadwolf_forge TO CURRENT_USER;
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
  -- impersonation_sessions (ADR-0011) is platform-owned staff data — deny the customer app role entirely.
  REVOKE ALL ON impersonation_sessions FROM leadwolf_app;
  -- jit_elevations (ADR-0011 / 13a F1) is platform-owned staff data too — the app role must never see who is
  -- elevated for what. RLS denies it; REVOKE the blanket grant (defence-in-depth). withPlatformTx (owner) is unaffected.
  REVOKE ALL ON jit_elevations FROM leadwolf_app;
  -- support_notes (13a Area 3) is platform-owned staff data — a customer must never read staff notes about
  -- their org. RLS denies it; REVOKE the blanket grant too. withPlatformTx (owner) is unaffected.
  REVOKE ALL ON support_notes FROM leadwolf_app;
  -- account_holds (13a Area 7) is platform-owned staff abuse data — deny-all to the customer app role.
  REVOKE ALL ON account_holds FROM leadwolf_app;
  -- announcements (13a Area 10) is platform-owned authoring data — deny-all to the customer app role; the
  -- customer banner read goes through a dedicated server-scoped api endpoint (owner connection), not this table.
  REVOKE ALL ON announcements FROM leadwolf_app;
  -- retention_policies (13a Area 8) is platform-owned compliance config — deny-all to the customer app role.
  REVOKE ALL ON retention_policies FROM leadwolf_app;
  -- credit_packs (13a Area 5) is staff-authored pricing config — for now platform-owned (deny-all to the app
  -- role); the public pricing surface is separate. REVOKE the blanket grant. withPlatformTx (owner) unaffected.
  REVOKE ALL ON credit_packs FROM leadwolf_app;
  -- plan_templates (13a Area 5) is staff-authored plan config — platform-owned, deny-all to the app role.
  -- REVOKE the blanket grant. withPlatformTx (owner) unaffected.
  REVOKE ALL ON plan_templates FROM leadwolf_app;
  -- approval_requests (database-management-research 09) is platform-owned maker-checker staff data — the customer
  -- app role must never read or tamper with the staff approval workflow. RLS denies it; REVOKE the blanket grant
  -- too (defence-in-depth). withPlatformTx (owner) is unaffected.
  REVOKE ALL ON approval_requests FROM leadwolf_app;
  -- sub_processors (13a Area 8 / GDPR Art. 28) is staff-published compliance config — platform-owned, deny-all
  -- to the customer app role. REVOKE the blanket grant. withPlatformTx (owner) unaffected.
  REVOKE ALL ON sub_processors FROM leadwolf_app;
  -- Layer-0 master graph (ADR-0021) is SYSTEM-OWNED, isolated by ACCESS PATH not RLS: it has NO workspace_id,
  -- so NO fail-closed RLS predicate. The blanket GRANT above handed leadwolf_app DML on it — REVOKE it so the
  -- customer app role can NEVER read the shared universe directly (PLAN_04/PLAN_07 "grant-off is the wall").
  -- Reads happen only via masked search + the paid-reveal copy + the audited owner/withPlatformTx path. The
  -- overlay's master_*_id FK still works: referential checks run with the table-OWNER privilege, not leadwolf_app.
  -- Re-run every migrate (idempotent); a future master_* table MUST be added to this list.
  REVOKE ALL ON master_persons, master_companies, master_employment, master_emails, master_phones,
                source_records, match_links, projection_outbox FROM leadwolf_app;
  -- Defense-in-depth belt: dynamically REVOKE from leadwolf_app any table named master_*. A FUTURE Layer-0
  -- master table is auto-granted by the ALTER DEFAULT PRIVILEGES above at CREATE time, so this convention-based
  -- catch-all makes it fail closed even before someone adds it to the explicit list. (Tables NOT matching
  -- master_* — source_records, match_links, and future system-owned Layer-0 tables — still rely on the explicit
  -- list above; each phase MUST add its system-owned tables there.) Idempotent; re-run every migrate.
  DO $$ DECLARE t text; BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename ~ '^master_' LOOP
      EXECUTE format('REVOKE ALL ON public.%I FROM leadwolf_app', t);
    END LOOP;
  END $$;
  -- leadwolf_er is the least-privilege Layer-0 resolution role (ADR-0021 MATCH-AGAINST; PLAN_01 §4): it READS the
  -- master graph and performs co-op-safe MINTS (the deterministic resolve-for-import path). It gets explicit
  -- SELECT/INSERT/UPDATE on the Layer-0 tables ONLY — NO DELETE (deletion is the audited DSAR fan-out on the
  -- owner/withPrivilegedTx path), NO overlay grant (it must never touch contacts/accounts), and it is NOT
  -- BYPASSRLS (it has no business reading any RLS-scoped table). It needs sequence USAGE to default the v7 PKs.
  -- Idempotent; re-run every migrate. A future Layer-0 table that the resolver writes MUST be added here.
  GRANT SELECT, INSERT, UPDATE ON master_persons, master_companies, master_employment, master_emails,
                                   master_phones, source_records, match_links, projection_outbox,
                                   processed_sync_events TO leadwolf_er;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO leadwolf_er;
  -- leadwolf_forge (ADR-0047) owns the forge schema data plane end-to-end (raw to parsed to verified + ER +
  -- governance). Full DML there (DELETE included — raw-layer DSAR erasure runs in-schema), but NO grant on the
  -- public/overlay tables (the blanket grants above are IN SCHEMA public, so forge stays unreachable to
  -- leadwolf_app by default — the same-repo firewall). Promotion into the master graph is a SEPARATE hop under
  -- withErTx (leadwolf_er). Idempotent; re-run every migrate.
  GRANT USAGE ON SCHEMA forge TO leadwolf_forge;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA forge TO leadwolf_forge;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA forge TO leadwolf_forge;
  ALTER DEFAULT PRIVILEGES IN SCHEMA forge
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO leadwolf_forge;
  ALTER DEFAULT PRIVILEGES IN SCHEMA forge
    GRANT USAGE, SELECT ON SEQUENCES TO leadwolf_forge;
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
