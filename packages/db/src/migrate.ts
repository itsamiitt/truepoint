// migrate.ts — the CLI wired to `bun run db:migrate` (after `drizzle-kit generate`). Delegates to the shared
// applyMigrations routine so the CLI and the integration tests run the exact same bootstrap → tables → RLS
// sequence (03 §9). Safe to run repeatedly.

import { env } from "@leadwolf/config";
import { applyMigrations } from "./applyMigrations.ts";

// Prefer the direct (non-pooled) URL for migrations when provided; otherwise use DATABASE_URL.
applyMigrations(env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL, {
  appRolePassword: env.DATABASE_APP_ROLE_PASSWORD,
  adminRolePassword: env.DATABASE_ADMIN_ROLE_PASSWORD,
})
  .then(() => {
    console.log("migrate: done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("migrate: failed", err);
    process.exit(1);
  });
