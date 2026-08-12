// One tiny seam over two drivers: PGlite (tests/dev — real Postgres semantics,
// no server) and postgres.js (production). Repositories depend only on DbClient.

export interface DbClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Multi-statement script execution (migrations). No parameters. */
  exec(text: string): Promise<void>;
  close(): Promise<void>;
}

export async function createPgliteClient(dataDir?: string): Promise<DbClient> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(dataDir);
  return {
    async query<T>(text: string, params?: unknown[]): Promise<T[]> {
      const res = await pg.query<T>(text, params as never[]);
      return res.rows;
    },
    async exec(text: string): Promise<void> {
      await pg.exec(text);
    },
    async close() {
      await pg.close();
    },
  };
}

export async function createPostgresClient(url: string): Promise<DbClient> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 10 });
  return {
    async query<T>(text: string, params?: unknown[]): Promise<T[]> {
      const rows = await sql.unsafe(text, (params ?? []) as never[]);
      return rows as unknown as T[];
    },
    async exec(text: string): Promise<void> {
      await sql.unsafe(text).simple();
    },
    async close() {
      await sql.end();
    },
  };
}
