// userScopedAuthIsolation.itest.ts — defense-in-depth proof (real Postgres 16) that the customer app role
// leadwolf_app is DENIED the owner-only user-scoped auth tables. These have NO RLS (the boundary is the access
// PATH, not a row predicate), so before the REVOKE the blanket grant would have let a raw leadwolf_app query
// read encrypted MFA secrets, login-OTP code hashes, or passkey credentials. user_sessions deliberately KEEPS
// its grant (the workspace-admin session-management path reads it via withTenantTx) — asserted as a positive
// control. Run in its own process: `bun test packages/db/test/userScopedAuthIsolation.itest.ts`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { applyMigrations } from "../src/applyMigrations.ts";
import { type ItestDb, startItestDb } from "./itestDb.ts";

let dbHandle: ItestDb;
let app: ReturnType<typeof postgres>; // the non-BYPASSRLS leadwolf_app role the customer API runs as

async function caught(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
    throw new Error("expected the call to reject, but it resolved");
  } catch (err) {
    return err as Error;
  }
}

beforeAll(async () => {
  dbHandle = await startItestDb("userScopedAuthIsolation");
  await applyMigrations(dbHandle.adminUrl);
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await dbHandle?.stop();
});

describe("user-scoped auth-table isolation (defense-in-depth REVOKE)", () => {
  for (const table of [
    "user_mfa_methods",
    "auth_email_tokens",
    "trusted_devices",
    "webauthn_credentials",
  ]) {
    test(`leadwolf_app cannot read ${table} (REVOKE)`, async () => {
      const err = await caught(() => app.unsafe(`SELECT 1 FROM ${table} LIMIT 1`));
      expect(err.message).toMatch(/permission denied/i);
    });
  }

  test("user_sessions deliberately KEEPS the grant (positive control)", async () => {
    // Must NOT be permission-denied — the workspace-admin session-management path reads it via withTenantTx.
    // Resolving (0 rows) proves the grant is intact; the no-RLS raw-read gap is a noted separate follow-up.
    await app.unsafe(`SELECT 1 FROM user_sessions LIMIT 1`);
    expect(true).toBe(true);
  });
});
