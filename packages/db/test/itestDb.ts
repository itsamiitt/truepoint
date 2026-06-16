// itestDb.ts — provision the integration-test Postgres: Testcontainers (postgres:16) by default, or an
// EXTERNAL server via ITEST_DATABASE_URL for environments without Docker (CI service containers, local
// clusters). External mode creates one isolated database per call so itest files never collide; both modes
// hand back the admin URL plus the non-BYPASSRLS leadwolf_app URL the RLS proofs connect with.

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

export async function startItestDb(name: string): Promise<ItestDb> {
  const external = process.env.ITEST_DATABASE_URL;
  if (external) {
    const database = `itest_${name}_${Date.now().toString(36)}`;
    const root = postgres(external, { max: 1, onnotice: () => {} });
    // Quote the identifier: an uppercase name (e.g. "workspaceSwitch") is otherwise folded to lowercase by
    // CREATE DATABASE while the connection URL keeps the original case -> "database does not exist".
    await root.unsafe(`CREATE DATABASE "${database}"`);
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
