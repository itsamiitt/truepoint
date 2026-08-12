// Bun entry point. DATABASE_URL selects the driver: unset → PGlite (dev,
// migrated + seeded in-process); set → real Postgres.

import {
  type DbClient,
  applyMigrations,
  createPgliteClient,
  createPostgresClient,
  seedExample,
} from "@cascade/db";
import { createApp } from "./app";

const PORT = Number(process.env.PORT ?? 3100);

async function bootstrap(): Promise<DbClient> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const db = await createPostgresClient(url);
    const applied = await applyMigrations(db);
    if (applied.length) console.info({ msg: "migrations_applied", applied });
    return db;
  }
  console.info({
    msg: "using_pglite",
    note: "ephemeral dev database, seeded with the example graph",
  });
  const db = await createPgliteClient();
  await applyMigrations(db);
  await seedExample(db);
  return db;
}

const db = await bootstrap();
const app = createApp({ db, apiKey: process.env.CASCADE_API_KEY });

console.info({ msg: "listening", port: PORT });

export default { port: PORT, fetch: app.fetch };
