// applyMigrations.ts — the reusable migration routine shared by the CLI (migrate.ts) and the integration
// tests. Three idempotent phases against a given connection string: bootstrap (extensions, uuid_generate_v7,
// the non-BYPASSRLS leadwolf_app role) → drizzle-generated table migrations → every src/rls/*.sql
// (policies + triggers). Takes the connection string as an argument so it has no dependency on @leadwolf/config.

import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "migrations");
const rlsFolder = join(here, "rls");

// leadwolf_app login password: the app connects AS leadwolf_app (RLS-enforced), so this is its real login
// secret — override via DATABASE_APP_ROLE_PASSWORD in production. Managed Postgres (Neon) rejects weak
// passwords on CREATE ROLE, so the default is strong. leadwolf_admin is NOLOGIN (reached only via SET ROLE
// by the owner for the audited DSAR/admin path) — it needs no password and cannot be logged into directly.
const DEFAULT_APP_ROLE_PASSWORD = "Lw_App_Role_2026!x7Qm";

/** SQLSTATEs tolerated during convergence: the object a skipped-then-replayed migration creates may
 *  already exist under an earlier lineage. Everything else aborts — tolerance is for "already there", never
 *  for real failures.
 *
 *  Precision on what "lineage" means here, because the previous wording ("renumbered tags = new hashes over
 *  old DDL") was misleading: identity is `sha256(CONTENT)` only — see the hash below — so RENAMING a migration
 *  changes nothing and a renamed file is still recognised as applied. What produced divergent hashes over
 *  equivalent DDL was the branch merge REWRITING file contents, not the renumbering that accompanied it.
 *  The distinction matters: a pure rename is safe and needs no tolerance; a content edit to an applied
 *  migration is a new migration wearing an old name, and this tolerance is the only thing standing between
 *  that and a failed deploy.
 *
 *  Every code here is a DDL "this object already exists" error, where skipping the statement leaves the database
 *  in exactly the state the statement intended. That is what makes tolerance safe.
 *
 *  `23505` (unique_violation) was previously in this set, annotated "idempotent seed rows", and it did not belong:
 *  it is a DATA error, not an "already exists" one. Tolerating it meant that ANY unique violation, in ANY
 *  statement of ANY migration — including a genuine conflict in a data backfill — was swallowed, the statement
 *  silently skipped, and the migration then marked applied. The result is a half-migrated database that reports
 *  success, which is the worst possible outcome for a forward-only migrator with no `down`.
 *
 *  Nothing needed it: every INSERT across all 16 seed-bearing migrations is already guarded with ON CONFLICT
 *  (verified — no file has more INSERTs than ON CONFLICT clauses), so re-running a seed raises nothing at all.
 *  A future seed must do the same; that is the correct idempotency mechanism, and it is expressed in the SQL
 *  where a reader can see it rather than in a blanket exception here. */
const ALREADY_EXISTS = new Set([
  "42P07", // duplicate_table
  "42710", // duplicate_object (constraints, triggers, roles)
  "42701", // duplicate_column
  "42P06", // duplicate_schema
  "42723", // duplicate_function
]);

/** True when a failed statement can be skipped without changing the database's intended end state.
 *  Exported so the tolerance policy itself is unit-testable — it is the difference between a migrator that
 *  converges and one that reports success on a half-applied migration. */
export function isTolerableMigrationError(code: string | undefined): boolean {
  return code !== undefined && ALREADY_EXISTS.has(code);
}

/**
 * Apply journal migrations by HASH MEMBERSHIP, not timestamp. Drizzle's own migrator skips any entry
 * whose journal timestamp is older than the last applied row — after branch lineages interleave (the
 * data-mgmt × main merge renumbered tags), a live database silently NEVER receives the missing entries
 * (prod's `relation "auth_policies" does not exist`). This walks the journal in order and executes
 * exactly the entries whose content-hash is absent from drizzle.__drizzle_migrations, statement by
 * statement (autocommit, hash row recorded LAST) so an interrupted run resumes convergently. Fresh
 * databases behave byte-identically to drizzle's migrator; the hash + table shape stay compatible.
 */
async function applyJournalByHash(sql: postgres.Sql, log: (m: string) => void): Promise<void> {
  const journalRaw = await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8");
  const journal = JSON.parse(journalRaw) as {
    entries: Array<{ idx: number; when: number; tag: string }>;
  };
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS drizzle;
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
    );`);
  const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations`;
  const applied = new Set(rows.map((r) => (r as { hash: string }).hash));
  for (const entry of journal.entries) {
    const content = await readFile(join(migrationsFolder, `${entry.tag}.sql`), "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    if (applied.has(hash)) continue;
    log(`migrate:        → ${entry.tag}\n`);
    for (const statement of content.split("--> statement-breakpoint")) {
      const q = statement.trim();
      if (!q) continue;
      try {
        await sql.unsafe(q);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (isTolerableMigrationError(code)) {
          log(`migrate:          (tolerated ${code}: object already exists)\n`);
          continue;
        }
        throw err;
      }
    }
    await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${entry.when})`;
  }
}

/**
 * Build the `leadwolf_forge` role clauses (E-6.6).
 *
 * No password configured ⇒ NOLOGIN, exactly as before, and `withForgeTx` keeps using the owner connection
 * plus SET LOCAL ROLE. A password ⇒ the role gets LOGIN so the Forge pool can AUTHENTICATE as it, which makes
 * the same-repo firewall a property of the connection instead of a statement that has to succeed every time.
 * That matters more than it looks: if the SET LOCAL ROLE were ever skipped or errored, withForgeTx would run
 * as the OWNER — which CAN read customer contacts, the exact thing the firewall exists to prevent.
 *
 * The ELSE branch converges an EXISTING role. Every deployment created it NOLOGIN, so without it the flag
 * would only ever take effect on a fresh database and the hardening would silently never reach production.
 * It only ever GRANTS login, never revokes: a running deployment may already be authenticating as this role,
 * and pulling LOGIN out from under it mid-migrate would take Forge down.
 */
function forgeRoleClauses(forgePwd: string | undefined): {
  create: string;
  converge: string;
} {
  if (!forgePwd) return { create: "NOLOGIN", converge: "" };
  return {
    create: `LOGIN PASSWORD '${forgePwd}'`,
    converge: `    ELSE\n      ALTER ROLE leadwolf_forge LOGIN PASSWORD '${forgePwd}';\n`,
  };
}

/**
 * Converge an EXISTING `leadwolf_app` role's password — but ONLY when one was explicitly configured.
 *
 * The role was created with its password and never updated afterwards, which is a live deployment hazard now
 * that the runtime derives an app-role connection from `DATABASE_APP_ROLE_PASSWORD` (E-6.3). On any database
 * where the role already exists, setting that variable for the first time would leave the role on its OLD
 * password while the app connected with the NEW one: authentication fails, and every tenant query fails with
 * it. CI cannot catch this — it builds a fresh database each run, where creation and configuration always
 * agree — so it would only ever have appeared on a real deployment.
 *
 * Gated on an EXPLICIT password rather than converging unconditionally: `appPwd` falls back to a built-in
 * default, and an unconditional ALTER would quietly reset a password an operator had rotated out of band back
 * to that default. Explicit configuration is a statement of intent; the fallback is not.
 */
function appConvergeClause(explicitAppPwd: string | undefined): string {
  if (!explicitAppPwd) return "";
  return `    ELSE\n      ALTER ROLE leadwolf_app LOGIN PASSWORD '${explicitAppPwd}';\n`;
}

const bootstrap = (
  appPwd: string,
  explicitAppPwd: string | undefined,
  forgePwd: string | undefined,
): string => {
  const { create: forgeRoleClause, converge: forgeConvergeClause } = forgeRoleClauses(forgePwd);
  const appConvergeClause_ = appConvergeClause(explicitAppPwd);
  return `
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
${appConvergeClause_}    END IF;
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
      CREATE ROLE leadwolf_forge ${forgeRoleClause};
${forgeConvergeClause}    END IF;
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
};

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
  -- User-scoped AUTH-SERVICE tables — accessed ONLY on the owner connection (userRepository /
  -- authEmailTokenRepository use the owner db pool, never withTenantTx); the customer app role never queries them. The
  -- blanket grant above handed leadwolf_app DML anyway, and these tables have NO RLS (the boundary is the
  -- access path, not a row predicate), so a raw query would have read MFA secrets / passkey credentials /
  -- login OTP codes. REVOKE the grant so that's impossible even by mistake. The auth service (owner) is
  -- unaffected. webauthn_credentials (AUTH-024) — passkey public keys + which users have them.
  REVOKE ALL ON webauthn_credentials FROM leadwolf_app;
  -- user_mfa_methods — enrolled factors + encrypted TOTP secrets (owner-only via userRepository).
  REVOKE ALL ON user_mfa_methods FROM leadwolf_app;
  -- auth_email_tokens — email verification / login-OTP code HASHES (owner-only via authEmailTokenRepository).
  REVOKE ALL ON auth_email_tokens FROM leadwolf_app;
  -- trusted_devices — the "trust this device" registry (schema present, no repository yet — unused).
  REVOKE ALL ON trusted_devices FROM leadwolf_app;
  -- NOTE: user_sessions deliberately KEEPS the grant — the workspace-admin session-management path reads it via
  -- withTenantTx (bounded by a workspace_members join). Its no-RLS gap (a RAW query bypasses the join) wants an
  -- RLS policy rather than a revoke — a separate follow-up.
  -- Layer-0 master graph (ADR-0021) is SYSTEM-OWNED, isolated by ACCESS PATH not RLS: it has NO workspace_id,
  -- so NO fail-closed RLS predicate. The blanket GRANT above handed leadwolf_app DML on it — REVOKE it so the
  -- customer app role can NEVER read the shared universe directly (PLAN_04/PLAN_07 "grant-off is the wall").
  -- Reads happen only via masked search + the paid-reveal copy + the audited owner/withPlatformTx path. The
  -- overlay's master_*_id FK still works: referential checks run with the table-OWNER privilege, not leadwolf_app.
  -- Re-run every migrate (idempotent); a future master_* table MUST be added to this list.
  -- provenance_event joins this list for two reasons, not one: it is Layer-0-shaped (no workspace_id, so no
  -- writable RLS predicate — rls/provenanceEvent.sql), and it carries contributor_ref. Even though that ref is
  -- unresolvable outside the forge schema, handing the customer role the ability to READ per-record
  -- contribution patterns would undermine C-02 by correlation alone.
  -- (No backticks in this comment: it lives inside a template literal, where one would terminate the string.)
  REVOKE ALL ON master_persons, master_companies, master_employment, master_emails, master_phones,
                source_records, match_links, projection_outbox, provenance_event FROM leadwolf_app;
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
  -- provenance_event: INSERT is the point (the resolver appends assertions alongside the graph write, in the
  -- same transaction). SELECT serves the fold and the badge aggregate. UPDATE is granted only because the
  -- source_record_id ON DELETE SET NULL needs it; every other mutation is refused by the append-only trigger
  -- regardless of role, so the grant is not the control here.
  GRANT SELECT, INSERT, UPDATE ON master_persons, master_companies, master_employment, master_emails,
                                   master_phones, source_records, match_links, projection_outbox,
                                   processed_sync_events, provenance_event TO leadwolf_er;
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
  opts: {
    appRolePassword?: string;
    adminRolePassword?: string;
    /** Login password for `leadwolf_forge` (E-6.6). ABSENT means the role stays NOLOGIN, exactly as before —
     *  the Forge connection then keeps using the owner + SET LOCAL ROLE. Present means the role is granted
     *  LOGIN so `withForgeTx` can AUTHENTICATE as it, making the same-repo firewall a property of the
     *  connection rather than of a statement that has to succeed every time. */
    forgeRolePassword?: string;
  } = {},
): Promise<void> {
  // Single-quote-escape so a password containing ' can't break the bootstrap SQL.
  // EXPLICIT configuration (option, then env) is tracked apart from the built-in fallback, because only an
  // explicit value may converge an existing role's password — see appConvergeClause.
  const explicitAppPwd = (opts.appRolePassword ?? process.env.DATABASE_APP_ROLE_PASSWORD)?.replace(
    /'/g,
    "''",
  );
  const appPwd = explicitAppPwd ?? DEFAULT_APP_ROLE_PASSWORD.replace(/'/g, "''");
  // The forge login password falls back to process.env rather than @leadwolf/config: this module is
  // deliberately standalone (a connection string plus explicit options, no config dependency), and the
  // fallback is what lets the integration suite exercise the LOGIN path — the itests call applyMigrations()
  // with no options, so without it every one of them would keep the NOLOGIN role and the path would ship
  // untested. An explicit option still wins.
  const forgePwdRaw = opts.forgeRolePassword ?? process.env.DATABASE_FORGE_ROLE_PASSWORD;
  const forgePwd = forgePwdRaw?.replace(/'/g, "''");
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
    await sql.unsafe(bootstrap(appPwd, explicitAppPwd, forgePwd));
    if (await exists(migrationsFolder)) {
      log("migrate: [2/4] applying table migrations…\n");
      await applyJournalByHash(sql, log);
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
