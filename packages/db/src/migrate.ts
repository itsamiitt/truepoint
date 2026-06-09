// migrate.ts — the CLI wired to `bun run db:migrate` (after `drizzle-kit generate`). Delegates to the shared
// applyMigrations routine so the CLI and the integration tests run the exact same bootstrap → tables → RLS
// sequence (03 §9). Safe to run repeatedly.

import { env } from "@leadwolf/config";
import { applyMigrations } from "./applyMigrations.ts";

applyMigrations(env.DATABASE_URL)
  .then(() => {
    console.log("migrate: done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("migrate: failed", err);
    process.exit(1);
  });
