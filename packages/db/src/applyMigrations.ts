// applyMigrations.ts — the reusable migration routine shared by the CLI (migrate.ts) and the integration
// tests. Three idempotent phases against a given connection string: bootstrap (extensions, uuid_generate_v7,
// the non-BYPASSRLS leadwolf_app role) → drizzle-generated table migrations → every src/rls/*.sql
// (policies + triggers). Takes the connection string as an argument so it has no dependency on @leadwolf/config.

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "migrations");
const rlsFolder = join(here, "rls");

const BOOTSTRAP = `
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
      CREATE ROLE leadwolf_app LOGIN PASSWORD 'leadwolf_app';
    END IF;
  END $$;
  GRANT USAGE ON SCHEMA public TO leadwolf_app;
`;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function applyMigrations(connectionString: string): Promise<void> {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  const db = drizzle(sql);
  try {
    await sql.unsafe(BOOTSTRAP);
    if (await exists(migrationsFolder)) {
      await migrate(db, { migrationsFolder });
    } else {
      console.warn(`applyMigrations: no migrations at ${migrationsFolder} — run \`drizzle-kit generate\` first.`);
    }
    const files = (await readdir(rlsFolder)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      await sql.unsafe(await readFile(join(rlsFolder, file), "utf8"));
    }
  } finally {
    await sql.end();
  }
}
