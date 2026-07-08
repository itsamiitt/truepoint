// webauthnCredentialsIsolation.itest.ts — isolation proof for the passkey credential store (AUTH-024 foundation)
// on a real Postgres 16. Proves: (1) the auth-service owner path CAN store a credential; (2) the customer app
// role leadwolf_app can NEITHER read NOR write it (REVOKE — the tenant app never touches passkeys, and can't
// even enumerate which users have credentials); (3) credential_id is unique (no duplicate registration). The
// registration/assertion CEREMONY is a separate, review-gated slice — this only proves the schema + isolation.
// Run in its own process: `bun test packages/db/test/webauthnCredentialsIsolation.itest.ts`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { applyMigrations } from "../src/applyMigrations.ts";
import { type ItestDb, startItestDb } from "./itestDb.ts";

let dbHandle: ItestDb;
let owner: ReturnType<typeof postgres>; // migration/owner connection — the auth-service writer
let app: ReturnType<typeof postgres>; // the non-BYPASSRLS leadwolf_app role the customer API runs as
let userId = "";

async function caught(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
    throw new Error("expected the call to reject, but it resolved");
  } catch (err) {
    return err as Error;
  }
}

beforeAll(async () => {
  dbHandle = await startItestDb("webauthnCredentials");
  await applyMigrations(dbHandle.adminUrl);
  owner = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });
  const [u] = await owner`INSERT INTO users (email) VALUES ('pk@webauthn.test') RETURNING id`;
  userId = (u as { id: string }).id;
}, 240_000);

afterAll(async () => {
  await owner?.end();
  await app?.end();
  await dbHandle?.stop();
});

describe("webauthn_credentials isolation (AUTH-024 foundation)", () => {
  test("the owner (auth-service path) CAN store a passkey credential", async () => {
    const [row] = await owner`
      INSERT INTO webauthn_credentials (user_id, credential_id, public_key)
      VALUES (${userId}, 'cred-abc', ${Buffer.from([1, 2, 3])}) RETURNING id`;
    expect((row as { id: string }).id).toBeTruthy();
  });

  test("leadwolf_app cannot READ passkey credentials (REVOKE)", async () => {
    const err = await caught(() => app`SELECT id FROM webauthn_credentials LIMIT 1`);
    expect(err.message).toMatch(/permission denied/i);
  });

  test("leadwolf_app cannot WRITE passkey credentials (REVOKE)", async () => {
    const err = await caught(
      () =>
        app`INSERT INTO webauthn_credentials (user_id, credential_id, public_key) VALUES (${userId}, 'forge', ${Buffer.from([0])})`,
    );
    expect(err.message).toMatch(/permission denied/i);
  });

  test("credential_id is unique — a duplicate registration is rejected", async () => {
    const err = await caught(
      () =>
        owner`INSERT INTO webauthn_credentials (user_id, credential_id, public_key) VALUES (${userId}, 'cred-abc', ${Buffer.from([9])})`,
    );
    expect(err.message).toMatch(/unique|duplicate/i);
  });
});
