// forgeSchemaIsolation.itest.ts — pins the wall between the FORGE data plane and the TENANT plane (ADR-0047,
// the same-repo firewall), on a real Postgres 16. Run in its OWN process (the db client is a module
// singleton): `bun test ./packages/db/test/forgeSchemaIsolation.itest.ts`.
//
// This exists because `withForgeTx`'s justification comment was FACTUALLY WRONG. It claimed the forge tables
// "carry no workspace_id", which would make unscoped reads self-evidently safe. They do carry one:
// `forge.raw_captures.target_tenant_id` is NOT NULL and `target_workspace_id` exists. Every forge read really
// is unscoped, so the question "what actually isolates this?" had a wrong answer written next to it — the
// most dangerous kind, because it invites a reader to extend the pattern on a false premise.
//
// The real answer is SCHEMA + ROLE, exactly like the Layer-0 grant-off wall (masterGraphIsolation.itest.ts):
// `leadwolf_forge` owns the `forge` schema and has no grant on the public/overlay tables, and `leadwolf_app`
// has no USAGE on `forge`. That is a Postgres-enforced wall, not app discipline — and it is what this file
// proves, so the absence of RLS inside forge is a PINNED, deliberate decision rather than an oversight.
//
// What this file deliberately does NOT claim: that forge is isolated BETWEEN tenants. It is not. Forge is a
// shared, staff-operated plane by design; cross-tenant reads through it are governed by audit (ADR-0032)
// rather than by row filters. Test 3 pins that asymmetry explicitly so nobody later reads this file as
// evidence of per-tenant isolation it does not provide.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

/** Postgres "insufficient_privilege" — proof the wall is grant-off, not an empty result set. */
const PERMISSION_DENIED = "42501";

/** A representative slice of the forge plane: the raw landing table, the parsed layer, the governed output,
 *  and the promotion bridge. If leadwolf_app can reach ANY of these the firewall is gone. */
const FORGE_TABLES = [
  "raw_captures",
  "parsed_records",
  "verified_records",
  "extraction_runs",
  "review_tasks",
  "master_id_map",
  "sync_outbox",
] as const;

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;

beforeAll(async () => {
  dbHandle = await startItestDb("forge-schema-isolation");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });
}, 180_000);

afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await app?.end({ timeout: 5 });
  await dbHandle?.stop();
});

/** Run `sql` as leadwolf_app inside a fully-GUC'd tenant tx and return the SQLSTATE it failed with (or ""),
 *  so a denial is provably the missing GRANT rather than a missing GUC or an RLS filter. */
async function deniedCode(statement: string): Promise<string> {
  try {
    await app.begin(async (tx) => {
      await tx`SELECT set_config('role', 'leadwolf_app', true)`;
      await tx`SELECT set_config('app.current_tenant_id', '11111111-1111-1111-1111-111111111111', true)`;
      await tx`SELECT set_config('app.current_workspace_id', '22222222-2222-2222-2222-222222222222', true)`;
      await tx.unsafe(statement);
    });
    return "";
  } catch (e) {
    return (e as { code?: string }).code ?? "";
  }
}

describe("forge plane ↔ tenant plane isolation (ADR-0047 same-repo firewall)", () => {
  test("THE SCHEMA WALL: leadwolf_app has no USAGE on schema forge", async () => {
    // The load-bearing grant. Without USAGE on the schema, no table inside it is addressable at all — which is
    // why the absence of RLS on those tables is not an exposure.
    const [row] = await admin`
      SELECT has_schema_privilege('leadwolf_app', 'forge', 'USAGE') AS has_usage`;
    expect((row as { has_usage: boolean }).has_usage).toBe(false);
  });

  test("leadwolf_app is DENIED (42501) on every forge table — read AND write", async () => {
    // Denied, not "returns zero rows". A zero-row result would mean an RLS predicate is doing the work and
    // could be widened by a future policy edit; a privilege denial cannot be widened by accident.
    for (const table of FORGE_TABLES) {
      expect(await deniedCode(`SELECT * FROM forge.${table} LIMIT 1`)).toBe(PERMISSION_DENIED);
      expect(await deniedCode(`INSERT INTO forge.${table} DEFAULT VALUES`)).toBe(PERMISSION_DENIED);
      expect(await deniedCode(`UPDATE forge.${table} SET id = id`)).toBe(PERMISSION_DENIED);
      expect(await deniedCode(`DELETE FROM forge.${table}`)).toBe(PERMISSION_DENIED);
    }
  });

  test("withForgeTx AUTHENTICATES as leadwolf_forge when the role has LOGIN (E-6.6)", async () => {
    // Same silent-inertness problem as the tenant pool: the forge URL falls back to the owner connection when
    // no forge-role password is configured, and every other test passes either way because the owner can do
    // everything leadwolf_forge can and more. session_user is the only thing that distinguishes "firewall
    // enforced by the connection" from "firewall enforced by a SET LOCAL ROLE that happened to run".
    const dbmod = await import("@leadwolf/db");
    const identity = await dbmod.withForgeTx(async (tx) => {
      const rows = (await tx.execute(
        "SELECT session_user::text AS session_user, current_user::text AS current_user",
      )) as unknown as Array<{ session_user: string; current_user: string }>;
      return rows[0];
    });
    expect(identity?.session_user).toBe("leadwolf_forge");
    // current_user was already leadwolf_forge before this change, so it alone proves nothing — asserted so a
    // regression that drops the SET LOCAL ROLE is still caught.
    expect(identity?.current_user).toBe("leadwolf_forge");
  });

  test("the forge role cannot reach the tenant overlay either — the firewall is TWO-WAY", async () => {
    // The direction that matters for PII: the ingest→verify pipeline must never be able to read a customer's
    // contacts. Asserted from the owner connection by dropping into leadwolf_forge, mirroring withForgeTx.
    const denied = async (statement: string): Promise<string> => {
      try {
        await admin.begin(async (tx) => {
          await tx`SET LOCAL ROLE leadwolf_forge`;
          await tx.unsafe(statement);
        });
        return "";
      } catch (e) {
        return (e as { code?: string }).code ?? "";
      }
    };
    expect(await denied("SELECT * FROM contacts LIMIT 1")).toBe(PERMISSION_DENIED);
    expect(await denied("SELECT * FROM users LIMIT 1")).toBe(PERMISSION_DENIED);
    expect(await denied("SELECT * FROM platform_audit_log LIMIT 1")).toBe(PERMISSION_DENIED);
  });

  test("PINNED, NOT ASSUMED: forge tables carry tenant columns and are NOT row-isolated by them", async () => {
    // The premise correction. `withForgeTx` used to justify unscoped reads with "the forge tables carry no
    // workspace_id" — they do. This asserts both halves of the truth so the next reader inherits the real
    // model: the columns exist, and NO RLS is enforcing them. Isolation is the schema wall above, and
    // cross-tenant reads inside forge are governed by audit (ADR-0032), not by row filters.
    const [cols] = await admin`
      SELECT
        count(*) FILTER (WHERE column_name = 'target_tenant_id')    AS tenant_col,
        count(*) FILTER (WHERE column_name = 'target_workspace_id') AS workspace_col
      FROM information_schema.columns
      WHERE table_schema = 'forge' AND table_name = 'raw_captures'`;
    expect(Number((cols as { tenant_col: string }).tenant_col)).toBe(1);
    expect(Number((cols as { workspace_col: string }).workspace_col)).toBe(1);

    // If this ever flips to true, someone enabled RLS inside forge — a real improvement, but one that makes
    // every existing unscoped reader's behaviour change. This test failing is the signal to re-read them.
    const [rls] = await admin`
      SELECT relrowsecurity FROM pg_class
      WHERE oid = 'forge.raw_captures'::regclass`;
    expect((rls as { relrowsecurity: boolean }).relrowsecurity).toBe(false);
  });
});
