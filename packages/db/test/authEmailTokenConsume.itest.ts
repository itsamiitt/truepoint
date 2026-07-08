// authEmailTokenConsume.itest.ts — the email-OTP / magic-link / verify token store is SINGLE-USE, and this proves
// it on real Postgres. consume() is `UPDATE ... SET consumed_at=now WHERE token_hash=? AND consumed_at IS NULL
// AND expires_at>now RETURNING`, so racing calls serialize on the row lock: exactly ONE wins. That atomicity is
// the anti-replay guarantee behind email-OTP MFA and magic-link sign-in; this guards it against a refactor to a
// check-then-delete (which would open a reuse race = a login bypass).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let dbmod: DbModule;

beforeAll(async () => {
  dbHandle = await startItestDb("authEmailTokenConsume");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await dbHandle?.stop();
});

const future = (): Date => new Date(Date.now() + 15 * 60_000);

describe("authEmailTokenRepository.consume — atomic single-use", () => {
  test("racing consumes on the same token → exactly ONE succeeds (no replay)", async () => {
    await dbmod.authEmailTokenRepository.create({
      tokenHash: "race-token",
      email: "race@otp.test",
      purpose: "email_otp",
      expiresAt: future(),
    });
    const results = await Promise.all([
      dbmod.authEmailTokenRepository.consume("race-token"),
      dbmod.authEmailTokenRepository.consume("race-token"),
      dbmod.authEmailTokenRepository.consume("race-token"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("re-consuming an already-used token is false", async () => {
    await dbmod.authEmailTokenRepository.create({
      tokenHash: "once-token",
      email: "once@otp.test",
      purpose: "email_otp",
      expiresAt: future(),
    });
    expect(await dbmod.authEmailTokenRepository.consume("once-token")).toBe(true);
    expect(await dbmod.authEmailTokenRepository.consume("once-token")).toBe(false);
  });

  test("an expired token cannot be consumed", async () => {
    await dbmod.authEmailTokenRepository.create({
      tokenHash: "expired-token",
      email: "expired@otp.test",
      purpose: "email_otp",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await dbmod.authEmailTokenRepository.consume("expired-token")).toBe(false);
  });

  test("an unknown token is false", async () => {
    expect(await dbmod.authEmailTokenRepository.consume("no-such-token")).toBe(false);
  });
});
