// webauthnCredentialRepo.itest.ts — CRUD round-trip for the passkey credential repository (AUTH-024) on real
// Postgres 16: create → listForUser / findByCredentialId (public key + counter round-trip) → updateCounter →
// unique credential_id. Runs in its own process: `bun test packages/db/test/webauthnCredentialRepo.itest.ts`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;
let userId = "";

beforeAll(async () => {
  dbHandle = await startItestDb("webauthnCredentialRepo");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  const [u] = await admin`INSERT INTO users (email) VALUES ('pk-repo@webauthn.test') RETURNING id`;
  userId = (u as { id: string }).id;
  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("webauthnCredentialRepository", () => {
  test("create → list / find round-trips the public key + counter + transports", async () => {
    await dbmod.webauthnCredentialRepository.create({
      userId,
      credentialId: "cred-1",
      publicKey: new Uint8Array([1, 2, 3, 4]),
      counter: 0,
      transports: ["internal", "hybrid"],
      backedUp: true,
      label: "iPhone",
    });

    const list = await dbmod.webauthnCredentialRepository.listForUser(userId);
    expect(list).toHaveLength(1);
    expect(list[0]?.credentialId).toBe("cred-1");
    expect([...(list[0]?.publicKey ?? [])]).toEqual([1, 2, 3, 4]);
    expect(list[0]?.transports).toEqual(["internal", "hybrid"]);

    const found = await dbmod.webauthnCredentialRepository.findByCredentialId("cred-1");
    expect(found?.userId).toBe(userId);
    expect(found?.counter).toBe(0);
    expect(await dbmod.webauthnCredentialRepository.findByCredentialId("nope")).toBeNull();
  });

  test("updateCounter advances the signature counter", async () => {
    await dbmod.webauthnCredentialRepository.updateCounter("cred-1", 7);
    const found = await dbmod.webauthnCredentialRepository.findByCredentialId("cred-1");
    expect(found?.counter).toBe(7);
  });

  test("credential_id is unique — a duplicate registration throws", async () => {
    let threw = false;
    try {
      await dbmod.webauthnCredentialRepository.create({
        userId,
        credentialId: "cred-1",
        publicKey: new Uint8Array([9]),
        counter: 0,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
