// drizzle.config.ts — Drizzle Kit config: generate/apply migrations from the schema. RLS policies live
// alongside in src/rls/*.sql and are applied as part of the migration set (03 §9).
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
