// Minimal ordered-SQL migrator. Migrations are hand-authored files in
// src/migrations/ — never generated (the repo's drizzle-kit lesson, kept).

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DbClient } from "./client";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export async function applyMigrations(db: DbClient): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS cascade_migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set(
    (await db.query<{ filename: string }>("SELECT filename FROM cascade_migrations")).map(
      (r) => r.filename,
    ),
  );
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await db.exec(sql);
    await db.query("INSERT INTO cascade_migrations (filename) VALUES ($1)", [file]);
    applied.push(file);
  }
  return applied;
}
