// sourceFetchRegistry.itest.ts — behavioural proof of the URL fetch registry (0118) + the fetchAndLandUrl
// engine both the on-view path and the sweep share. On a real Postgres. Run in its OWN process:
//   bun test ./packages/db/test/sourceFetchRegistry.itest.ts
//
// Proofs:
//   1. THE WALL — leadwolf_app denied on source_fetch_registry (42501): app-REVOKEd, NOT master_*-prefixed,
//      so the explicit REVOKE is what protects it.
//   2. REGISTRY SEMANTICS — registerUrl is first-seen-only (never moves the clock); listDueForFetch returns
//      never-fetched first; recordFetch advances the clock + outcome; isFresh windows correctly.
//   3. FETCH-AND-LAND E2E — a person URL → stub fetch → landLinkedinPayload → registry stamped 'ok' + the
//      golden person id; the profile's employer company id is DERIVED into the registry as a company target;
//      a second call inside the window returns 'fresh' with no stub call.
//
// DB error capture uses try/catch, NEVER expect(...).rejects (the pooled-connection hang trap).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type CoreModule = typeof import("../../core/src/index.ts");
type DbModule = typeof import("@leadwolf/db");

const PERMISSION_DENIED = "42501";

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let core: CoreModule;
let dbmod: DbModule;

const PERSON_PAYLOAD = {
  schema_version: 1,
  profile_id: "ACwAAA_reg_urn",
  member_id: 42,
  public_identifier: "reg-jane",
  headline: "VP Sales",
  current_position: {
    title: "VP Sales",
    company_name: "Regco",
    company_id: 556677,
    is_current: true,
    start_date: "2025-01",
  },
  positions: [
    {
      title: "VP Sales",
      company_name: "Regco",
      company_id: 556677,
      is_current: true,
      start_date: "2025-01",
    },
  ],
  educations: [],
  skills: [],
  languages: [],
  volunteering: [],
  contact: { primary_email: null, emails: [], phones: [] },
};

beforeAll(async () => {
  dbHandle = await startItestDb("sourceFetchRegistry");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.LINKEDIN_SOURCE_LANDING_ENABLED = "true";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });
  dbmod = await import("@leadwolf/db");
  core = await import("../../core/src/index.ts");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

describe("source_fetch_registry + fetchAndLandUrl", () => {
  test("1. the wall: leadwolf_app is denied (explicit REVOKE)", async () => {
    let code: string | null = null;
    try {
      await app`SELECT count(*) FROM source_fetch_registry`;
    } catch (e) {
      code = (e as { code?: string }).code ?? null;
    }
    expect(code).toBe(PERMISSION_DENIED);
  });

  test("2. registry semantics: first-seen upsert, due-selection, recordFetch clock, isFresh", async () => {
    const url = "https://www.linkedin.com/in/reg-alpha";
    // registerUrl twice — must stay ONE row and NOT set last_fetched_at.
    const a = await dbmod.withPrivilegedTx((tx) =>
      dbmod.sourceFetchRegistryRepository.registerUrl(tx, {
        entityKind: "person",
        normalizedUrl: url,
        externalId: "reg-alpha",
      }),
    );
    await dbmod.withPrivilegedTx((tx) =>
      dbmod.sourceFetchRegistryRepository.registerUrl(tx, {
        entityKind: "person",
        normalizedUrl: url,
      }),
    );
    expect(a.lastFetchedAt).toBeNull();
    const [count] = await admin`
      SELECT count(*)::int AS n FROM source_fetch_registry WHERE normalized_url = ${url}`;
    expect(count!.n).toBe(1);

    // Never-fetched is due; fresh is not.
    const due = await dbmod.withPrivilegedTx((tx) =>
      dbmod.sourceFetchRegistryRepository.listDueForFetch(tx, "person", 30, 10),
    );
    expect(due.some((d) => d.normalizedUrl === url)).toBe(true);

    // recordFetch advances the clock + outcome; isFresh true within the window.
    await dbmod.withPrivilegedTx((tx) =>
      dbmod.sourceFetchRegistryRepository.recordFetch(tx, a.id, "ok", { personId: null }),
    );
    const fresh = await dbmod.withPrivilegedTx((tx) =>
      dbmod.sourceFetchRegistryRepository.isFresh(tx, "person", url, 30),
    );
    expect(fresh).toBe(true);
    const dueAfter = await dbmod.withPrivilegedTx((tx) =>
      dbmod.sourceFetchRegistryRepository.listDueForFetch(tx, "person", 30, 10),
    );
    expect(dueAfter.some((d) => d.normalizedUrl === url)).toBe(false); // fetched → no longer due
  });

  test("3. fetchAndLandUrl: fetch → land → stamp + derive company; second call is fresh", async () => {
    const url = "https://www.linkedin.com/in/reg-jane";
    let stubCalls = 0;
    const stubProfile = (() => {
      stubCalls += 1;
      return Promise.resolve({ status: "ok", payload: PERSON_PAYLOAD, originId: null } as const);
    }) as CoreModule["fetchLinkedinProfile"];

    const first = await core.fetchAndLandUrl({
      entityKind: "person",
      normalizedUrl: url,
      externalId: "reg-jane",
      fetchProfile: stubProfile,
    });
    expect(first.outcome).toBe("landed");
    expect(first.resolvedPersonId).not.toBeNull();
    expect(stubCalls).toBe(1);

    // Registry stamped ok + resolved id.
    const [row] = await admin`
      SELECT last_outcome, resolved_person_id, last_fetched_at
        FROM source_fetch_registry WHERE entity_kind='person' AND normalized_url=${url}`;
    expect(row!.last_outcome).toBe("ok");
    expect(row!.resolved_person_id).toBe(first.resolvedPersonId);
    expect(row!.last_fetched_at).not.toBeNull();

    // The employer company id (556677) was DERIVED into the registry as a company target.
    const [company] = await admin`
      SELECT count(*)::int AS n FROM source_fetch_registry
       WHERE entity_kind='company' AND external_id='556677'`;
    expect(company!.n).toBe(1);

    // Second call inside the window: fresh, no stub call.
    const second = await core.fetchAndLandUrl({
      entityKind: "person",
      normalizedUrl: url,
      externalId: "reg-jane",
      fetchProfile: stubProfile,
    });
    expect(second.outcome).toBe("fresh");
    expect(stubCalls).toBe(1);
  });

  test("4. a rejected fetch still advances the clock (rotates off the sweep head)", async () => {
    const url = "https://www.linkedin.com/in/reg-gone";
    const rejecting = (() =>
      Promise.resolve({
        status: "rejected",
        httpStatus: 404,
      } as const)) as CoreModule["fetchLinkedinProfile"];
    const res = await core.fetchAndLandUrl({
      entityKind: "person",
      normalizedUrl: url,
      externalId: "reg-gone",
      fetchProfile: rejecting,
    });
    expect(res.outcome).toBe("rejected");
    const [row] = await admin`
      SELECT last_outcome, last_fetched_at FROM source_fetch_registry
       WHERE entity_kind='person' AND normalized_url=${url}`;
    expect(row!.last_outcome).toBe("rejected");
    expect(row!.last_fetched_at).not.toBeNull();
  });
});
