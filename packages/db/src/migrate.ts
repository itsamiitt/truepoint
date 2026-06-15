// migrate.ts — the CLI wired to `bun run db:migrate`. Delegates to the shared applyMigrations routine so the
// CLI and the integration tests run the exact same bootstrap → tables → RLS sequence (03 §9). Safe to run
// repeatedly. Progress + result go to STDERR: Bun block-buffers stdout to a pipe, so under
// `docker compose run` stdout would stay invisible until exit (a working migration would look frozen).

import { writeSync } from "node:fs";
import { env } from "@leadwolf/config";
import { applyMigrations } from "./applyMigrations.ts";

// Direct synchronous write to fd 2 (stderr) — unbuffered even when stderr is a pipe (docker compose run).
const log = (m: string): void => {
  writeSync(2, m);
};

// Migrations must NOT run through a transaction-pooling endpoint: Drizzle's migrator opens a real DDL
// transaction (postgres-js `client.begin`) that PgBouncer can stall, and the pooler's connect-queue wait is
// NOT bounded by statement_timeout. Neon's pooled host is "<id>-pooler.<region>.…"; the direct host is the
// same minus "-pooler". So when DATABASE_MIGRATION_URL isn't set, derive the direct host by stripping
// "-pooler". No-op for any host without "-pooler" (local Postgres, RDS) — safe everywhere.
function directUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.replace("-pooler", "");
    return u.toString();
  } catch {
    return url;
  }
}

const target = env.DATABASE_MIGRATION_URL ?? directUrl(env.DATABASE_URL);
const masked = target.replace(/\/\/([^:]+):[^@]+@/, "//$1:****@");
log(`migrate: connecting to ${masked}\n`);

applyMigrations(target, {
  appRolePassword: env.DATABASE_APP_ROLE_PASSWORD,
  adminRolePassword: env.DATABASE_ADMIN_ROLE_PASSWORD,
})
  .then(() => {
    log("migrate: done.\n");
    process.exit(0);
  })
  .catch((err) => {
    log(`migrate: failed ${err?.stack ?? String(err)}\n`);
    process.exit(1);
  });
