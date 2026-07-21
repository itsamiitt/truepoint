// contactChannels.readcutover.itest.ts — S-CH4's test gate (import-and-data-model-redesign 05 §5/§6 §Testing,
// 15 §T-P3 / §R-P3): the READ CUTOVER proofs against a real Postgres 16 (Testcontainers by default, or
// ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process (db client + config are module singletons):
// `bun test ./packages/db/test/contactChannels.readcutover.itest.ts`
//
// What is proven, per 05 §5/§6:
//   1. MASKED SUMMARIES NEVER LEAK (§5, G16): gate-on the masked search hit carries `channels` (counts +
//      per-value {type,status,isPrimary}) but NEVER a value and NEVER a secondary email's domain — asserted
//      by scanning the serialized hit for the secondary value + its distinct domain.
//   2. GATE-OFF BYTE-IDENTITY (§R-P3): on IDENTICAL underlying data, the gate-off masked hit is byte-equal to
//      the gate-on hit MINUS the additive `channels` field (golden deep-compare) and carries no `channels`.
//   3. DEDUP EMAIL-RUNG PARITY (§6): a SECONDARY email's blind index resolves the contact gate-on (child rung)
//      and does NOT gate-off (flat rung holds only the primary) — the G15/G16 payoff; the PRIMARY resolves
//      either way (precedence preserved).
//   4. REVEAL PRIMARY-FIRST (§5): gate-on getRevealedContact returns ALL live email values primary-first for an
//      owned claim; gate-off the value arrays are ABSENT (byte-identical to the pre-S-CH4 payload).
//   5. SEARCH FACET PARITY (§5 / doc-16 drift): the `company` facet COUNT grouping stays on the flat primary
//      domain either way (the secondary domain never appears as a facet value).
//   6. S-CH4b READ-SIBLING AGREEMENT (doc-16 2026-07-06 gate-on consistency gap): the PAGE, the select-all
//      COUNT (core.searchCount), the bulk/reveal id-RESOLVE (resolveVisibleIds), and DYNAMIC-LIST MEMBERSHIP
//      (core.listListMembers) all consume the SAME child-presence predicates — a CHILD-ONLY-PRESENCE contact
//      (flat email NULL, one live child row) surfaces in ALL FOUR gate-on and NONE gate-off; the four agree.
//   7. S-CH4b REVEAL NARROWING RIDER: gate-on getRevealedContact fetches child ciphertext ONLY for the
//      channel(s) the workspace OWNS a claim for — an email-only claim still returns the owned email values,
//      the unowned phone channel stays absent (output identical to fetching both; the fetch is just narrower).
//
// Gate composition (05 §5): effective read-from-child = CHANNEL_READ_FROM_CHILD env AND the S-CH2 dual gate
// (CHANNEL_DUAL_WRITE env + channels_dual_write flag) AND the channels_read flag — read IMPLIES dual-write.
// Both env halves are armed for the whole process (frozen config); the on/off ARMS ride the per-tenant flags:
// tenantOn has BOTH flags (read gate ON); tenantOff keeps channels_read off (read gate OFF) but still has
// channels_dual_write on, so its child rows are byte-identical — the parity is over IDENTICAL data.
// Core is imported via the RELATIVE barrel (../../core/src/index.ts) — a @leadwolf/core dep is a Turbo cycle.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ContactQuery } from "@leadwolf/types";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;
let db: Db;

// On = channels_dual_write + channels_read (read gate ON). Off = channels_dual_write only (read gate OFF).
let tOn = "";
let wsOn = "";
let ownerOn = "";
let tOff = "";
let wsOff = "";
let ownerOff = "";

const SECONDARY_EMAIL = "jane.alt@personal.io"; // distinct DOMAIN so the "no secondary domain" leak is testable
const SECONDARY_DOMAIN = "personal.io";

const MAPPING = { email: "Email", firstName: "First Name", phone: "Phone", locationCountry: "Country" };
const ROWS = [
  { Email: "jane@acme.com", "First Name": "Jane", Phone: "(415) 555-2671", Country: "US" },
  { Email: "john@acme.com", "First Name": "John", Phone: "", Country: "" },
];

const scope = (tenantId: string, workspaceId: string) => ({ tenantId, workspaceId });

async function seedTenantWorkspace(slug: string) {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  return { tenantId, workspaceId: (w as { id: string }).id, ownerId };
}

async function enableFlag(tenantId: string, key: string) {
  await admin`INSERT INTO tenant_feature_flags (flag_key, tenant_id, enabled) VALUES (${key}, ${tenantId}, true)`;
}

async function contactIdByName(workspaceId: string, firstName: string): Promise<string> {
  const [r] = await admin`
    SELECT id FROM contacts WHERE workspace_id = ${workspaceId} AND first_name = ${firstName}`;
  return (r as { id: string }).id;
}

/** Seed a fully-loaded tenant: dual-write flag ON → import (primary child rows) → append a SECONDARY email on
 *  Jane (distinct domain) via the sanctioned writer → an owned full_profile reveal claim on Jane. */
async function seedLoaded(slug: string) {
  const s = await seedTenantWorkspace(slug);
  await enableFlag(s.tenantId, "channels_dual_write"); // dual-write ON so import writes child primaries
  const res = await core.runImport({
    scope: scope(s.tenantId, s.workspaceId),
    importedByUserId: s.ownerId,
    sourceName: "manual",
    mapping: MAPPING,
    conflictPolicy: "overwrite",
    rows: ROWS,
  });
  expect(res.created).toBe(2);
  const janeId = await contactIdByName(s.workspaceId, "Jane");
  // Append the secondary email through applyChannelWrite (CH-INV-1's single writer) — deterministic bytes so
  // the dedup-rung probe is exact. Jane already holds the primary jane@acme.com ⇒ this lands as a secondary.
  const outcome = await db.withTenantTx(scope(s.tenantId, s.workspaceId), (tx) =>
    db.contactChannelRepository.applyChannelWrite(tx, { tenantId: s.tenantId, workspaceId: s.workspaceId }, {
      kind: "email_upsert",
      contactId: janeId,
      value: {
        valueEnc: core.encryptPii(SECONDARY_EMAIL),
        blindIndex: core.blindIndex(SECONDARY_EMAIL),
        emailDomain: SECONDARY_DOMAIN,
        type: "personal",
        source: "provider:zoominfo",
      },
    }),
  );
  expect(outcome.result).toBe("inserted");
  // An owned full_profile claim so getRevealedContact unmasks Jane's live values (05 §5 — an email claim
  // unmasks ALL live email values). Inserted directly (no credits/suppression coupling in a read test).
  await admin`
    INSERT INTO contact_reveals (tenant_id, workspace_id, contact_id, revealed_by_user_id, reveal_type, data_source, credits_consumed)
    VALUES (${s.tenantId}, ${s.workspaceId}, ${janeId}, ${s.ownerId}, 'full_profile', 'internal', 0)`;
  return { ...s, janeId };
}

let janeOn = "";
let janeOff = "";

beforeAll(async () => {
  dbHandle = await startItestDb("contact_channels_readcutover");
  // env BEFORE the config/db singletons load (frozen config). Both env halves armed; the per-tenant flags drive
  // the on/off arms. The env-off short-circuit (zero queries) is a code-path fact, covered by the dualwrite/
  // backfill env-off proofs; here the flag layer alone holds the read-gate line with the env armed.
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.CHANNEL_DUAL_WRITE = "true";
  process.env.CHANNEL_READ_FROM_CHILD = "true";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  core = await import("../../core/src/index.ts");
  db = await import("@leadwolf/db");

  const on = await seedLoaded("rcon");
  tOn = on.tenantId;
  wsOn = on.workspaceId;
  ownerOn = on.ownerId;
  janeOn = on.janeId;
  await enableFlag(tOn, "channels_read"); // read gate ON for tenantOn

  const off = await seedLoaded("rcoff");
  tOff = off.tenantId;
  wsOff = off.workspaceId;
  ownerOff = off.ownerId;
  janeOff = off.janeId;
  // tenantOff: channels_read deliberately NOT enabled ⇒ read gate OFF (child rows identical, reads stay flat).
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const query = (over: Partial<ContactQuery> = {}): ContactQuery => ({
  filters: [],
  sort: "relevance",
  limit: 50,
  ...over,
});

const findJane = (hits: Array<{ firstName: string | null }>) =>
  hits.find((h) => h.firstName === "Jane") as unknown as Record<string, unknown> & {
    hasEmail: boolean;
    channels?: { emailCount: number; phoneCount: number; emailSummaries?: unknown[] };
  };

describe("S-CH4 §5 — masked channel summaries never leak values or secondary domains", () => {
  test("gate-on hit carries channels (counts + summaries) but no value / no secondary domain", async () => {
    const gate = await core.channelReadFromChildEnabledForScope(scope(tOn, wsOn));
    expect(gate).toBe(true); // composed gate ON for tenantOn
    const page = await db.searchRepository.searchContacts(scope(tOn, wsOn), query(), {
      channelsFromChild: gate,
    });
    const jane = findJane(page.hits);
    expect(jane.channels).toBeDefined();
    expect(jane.channels!.emailCount).toBe(2); // primary + secondary
    expect(jane.channels!.emailSummaries!.length).toBe(2);
    // THE G16 guard: the serialized masked hit exposes NO email value and NO secondary email's domain.
    const serialized = JSON.stringify(jane);
    expect(serialized).not.toContain(SECONDARY_EMAIL);
    expect(serialized).not.toContain(SECONDARY_DOMAIN);
    expect(serialized).not.toContain("jane@acme.com");
  });
});

describe("S-CH4 §R-P3 — gate-off is byte-identical to gate-on minus the additive channels field", () => {
  test("same data, same tenant: off hit === on hit without `channels`, and off has no channels key", async () => {
    const offPage = await db.searchRepository.searchContacts(scope(tOn, wsOn), query(), {
      channelsFromChild: false,
    });
    const onPage = await db.searchRepository.searchContacts(scope(tOn, wsOn), query(), {
      channelsFromChild: true,
    });
    const offJane = findJane(offPage.hits);
    const onJane = findJane(onPage.hits);
    expect("channels" in offJane).toBe(false); // gate-off omits the field entirely (byte-identical shape)
    expect(offJane.hasEmail).toBe(true);
    const { channels: _drop, ...onWithoutChannels } = onJane;
    expect(offJane).toEqual(onWithoutChannels as typeof offJane); // golden deep-compare
  });
});

describe("S-CH4 §6 — dedup email rung retargets to the child (secondaries resolve)", () => {
  test("a SECONDARY email's blind index resolves gate-on and NOT gate-off; the primary resolves either way", async () => {
    const secondaryBi = core.blindIndex(SECONDARY_EMAIL);
    const primaryBi = core.blindIndex("jane@acme.com");
    await db.withTenantTx(scope(tOn, wsOn), async (tx) => {
      // Secondary: child rung hits (gate-on), flat rung misses (gate-off).
      const onSecondary = await db.contactRepository.findByDedupKeys(
        tx,
        wsOn,
        { emailBlindIndex: secondaryBi },
        { channelsFromChild: true },
      );
      expect(onSecondary?.id).toBe(janeOn);
      const offSecondary = await db.contactRepository.findByDedupKeys(tx, wsOn, {
        emailBlindIndex: secondaryBi,
      });
      expect(offSecondary).toBeNull();
      // Primary: precedence preserved — resolves either way.
      const onPrimary = await db.contactRepository.findByDedupKeys(
        tx,
        wsOn,
        { emailBlindIndex: primaryBi },
        { channelsFromChild: true },
      );
      const offPrimary = await db.contactRepository.findByDedupKeys(tx, wsOn, {
        emailBlindIndex: primaryBi,
      });
      expect(onPrimary?.id).toBe(janeOn);
      expect(offPrimary?.id).toBe(janeOn);
    });
    // Batch mirror: the secondary key resolves gate-on in the IN-list path too.
    await db.withTenantTx(scope(tOn, wsOn), async (tx) => {
      const [hit] = await db.contactRepository.findByDedupKeysBatch(
        tx,
        wsOn,
        [{ emailBlindIndex: secondaryBi }],
        { channelsFromChild: true },
      );
      expect(hit?.id).toBe(janeOn);
    });
  });
});

describe("S-CH4 §5 — reveal reads all live values primary-first (owned claim)", () => {
  test("gate-on getRevealedContact returns emails primary-first; gate-off the arrays are absent", async () => {
    const on = await core.getRevealedContact(scope(tOn, wsOn), janeOn);
    expect(on).not.toBeNull();
    expect(on!.emails).toBeDefined();
    expect(on!.emails!.length).toBe(2);
    expect(on!.emails![0].isPrimary).toBe(true);
    expect(on!.emails![0].value).toBe("jane@acme.com"); // primary first (CH-INV-1)
    expect(on!.emails!.some((e) => e.value === SECONDARY_EMAIL && !e.isPrimary)).toBe(true);
    // Scalar `email` still means THE PRIMARY (byte-identical to the flat cache).
    expect(on!.email).toBe("jane@acme.com");

    const off = await core.getRevealedContact(scope(tOff, wsOff), janeOff);
    expect(off).not.toBeNull();
    expect(off!.emails).toBeUndefined(); // gate-off ⇒ additive arrays absent (byte-identical payload)
    expect(off!.email).toBe("jane@acme.com"); // the primary reveal is unchanged
  });
});

describe("S-CH4 §5 — the company facet COUNT grouping stays flat (primary domain only)", () => {
  test("acme.com is a facet value (both primaries); the secondary domain never appears", async () => {
    const gate = await core.channelReadFromChildEnabledForScope(scope(tOn, wsOn));
    const facets = await db.searchRepository.facetCounts(scope(tOn, wsOn), query(), ["company"]);
    const values = facets.map((f) => f.value);
    expect(values).toContain("acme.com"); // Jane + John primary domain
    expect(values).not.toContain(SECONDARY_DOMAIN); // grouping is flat-primary, never any-value (doc-16 drift)
    const acme = facets.find((f) => f.value === "acme.com");
    expect(acme?.count).toBe(2);
    void gate;
  });
});

// ── S-CH4b: the read siblings agree gate-on; flat gate-off (doc-16 2026-07-06 GATE-ON CONSISTENCY GAP) ──────
// The shipped S-CH4 cut the search PAGE over to the child-presence predicates but left the select-all COUNT,
// the bulk/reveal id-RESOLVE, and DYNAMIC-LIST MEMBERSHIP reading FLAT — so with channels_read on, a
// has_email-filtered page could disagree with "Select all N", the ids a bulk op mutates, and a dynamic list's
// members. S-CH4b threads the SAME composed gate into all three. Fixture: a CHILD-ONLY-PRESENCE contact
// (flat email_enc NULL + one live contact_emails row) — has_email is true ONLY via the child rung, so it is
// the exact probe that separates the child path from the flat path across every surface.

const HAS_EMAIL = (): ContactQuery =>
  query({ filters: [{ kind: "bool", field: "has_email", value: true }] });
const RESOLVE_CAP = 1000;

/** A contact with NO flat email (email_enc NULL) but ONE live child email row — the no-primary child-only
 *  edge state the child rung sees and the flat rung cannot. Inserted directly (no writer maintains the flat
 *  cache here — that divergence IS the fixture). */
async function seedChildOnlyEmail(
  tenantId: string,
  workspaceId: string,
  firstName: string,
  email: string,
  domain: string,
): Promise<string> {
  const [c] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, first_name)
    VALUES (${tenantId}, ${workspaceId}, ${firstName}) RETURNING id`;
  const cid = (c as { id: string }).id;
  await admin`
    INSERT INTO contact_emails
      (tenant_id, workspace_id, contact_id, value_enc, blind_index, email_domain, type, is_primary, status, source)
    VALUES (${tenantId}, ${workspaceId}, ${cid}, ${core.encryptPii(email)}, ${core.blindIndex(email)},
            ${domain}, 'work', true, 'unverified', 'provider:test')`;
  return cid;
}

/** Seed a saved has_email search + a DYNAMIC list backed by it (membership = its live query result). */
async function seedDynamicHasEmailList(
  tenantId: string,
  workspaceId: string,
  ownerId: string,
): Promise<string> {
  const saved = await db.withTenantTx(scope(tenantId, workspaceId), (tx) =>
    db.savedSearchRepository.insert(tx, {
      tenantId,
      workspaceId,
      ownerUserId: ownerId,
      name: "has-email",
      filters: HAS_EMAIL(),
      visibility: "workspace",
    }),
  );
  const list = await core.createDynamicList({
    scope: scope(tenantId, workspaceId),
    callerUserId: ownerId,
    name: "Has email (dynamic)",
    savedSearchId: saved.id,
  });
  return list.id;
}

/** Collect the four read surfaces' id sets for a tenant, evaluating the composed gate EXACTLY as each shipped
 *  caller does: searchPortProvider (the page), core.searchCount (select-all count), the reveal/bulk resolve
 *  two-liner (resolveVisibleIds), core.listListMembers (dynamic membership). */
async function fourSurfaces(t: string, ws: string, ownerId: string, listId: string) {
  const gate = await core.channelReadFromChildEnabledForScope(scope(t, ws));
  const page = await db.searchRepository.searchContacts(scope(t, ws), HAS_EMAIL(), {
    channelsFromChild: gate,
  });
  const count = await core.searchCount(scope(t, ws), HAS_EMAIL());
  const resolved = await db.withTenantTx(scope(t, ws), (tx) =>
    db.searchRepository.resolveVisibleIds(tx, HAS_EMAIL(), RESOLVE_CAP, { channelsFromChild: gate }),
  );
  const list = await core.listListMembers({
    scope: scope(t, ws),
    callerUserId: ownerId,
    listId,
    limit: 200,
  });
  return {
    gate,
    pageIds: new Set(page.hits.map((h) => h.id)),
    count: count.total,
    resolveIds: new Set(resolved),
    memberIds: new Set(list.members.map((m) => m.id)),
  };
}

describe("S-CH4b — page / count / resolve / dynamic-membership agree gate-on; flat gate-off", () => {
  let childOnlyOn = "";
  let childOnlyOff = "";
  let listOnId = "";
  let listOffId = "";

  beforeAll(async () => {
    childOnlyOn = await seedChildOnlyEmail(tOn, wsOn, "ChildOnlyOn", "child@onlyon.io", "onlyon.io");
    childOnlyOff = await seedChildOnlyEmail(tOff, wsOff, "ChildOnlyOff", "child@onlyoff.io", "onlyoff.io");
    listOnId = await seedDynamicHasEmailList(tOn, wsOn, ownerOn);
    listOffId = await seedDynamicHasEmailList(tOff, wsOff, ownerOff);
  }, 60_000);

  test("gate-on: the child-only-presence contact appears in ALL FOUR surfaces, which agree", async () => {
    const s = await fourSurfaces(tOn, wsOn, ownerOn, listOnId);
    expect(s.gate).toBe(true); // composed gate ON for tenantOn
    // Child-only presence: flat email NULL, one live child row ⇒ has_email is true ONLY via the child rung.
    expect(s.pageIds.has(childOnlyOn)).toBe(true);
    expect(s.resolveIds.has(childOnlyOn)).toBe(true);
    expect(s.memberIds.has(childOnlyOn)).toBe(true);
    // AGREEMENT: page ≡ resolve ≡ membership (as sets) and count = |page| — no surface can disagree with another.
    expect(s.resolveIds).toEqual(s.pageIds);
    expect(s.memberIds).toEqual(s.pageIds);
    expect(s.count).toBe(s.pageIds.size);
  });

  test("gate-off: the child-only-presence contact is ABSENT from all four (flat), which still agree", async () => {
    const s = await fourSurfaces(tOff, wsOff, ownerOff, listOffId);
    expect(s.gate).toBe(false); // read gate OFF for tenantOff (channels_read never enabled)
    // Flat rung only ⇒ the child-only contact never surfaces (byte-identical to the pre-S-CH4 flat path).
    expect(s.pageIds.has(childOnlyOff)).toBe(false);
    expect(s.resolveIds.has(childOnlyOff)).toBe(false);
    expect(s.memberIds.has(childOnlyOff)).toBe(false);
    // The flat siblings still agree with each other (count/resolve/membership never diverge from the page).
    expect(s.resolveIds).toEqual(s.pageIds);
    expect(s.memberIds).toEqual(s.pageIds);
    expect(s.count).toBe(s.pageIds.size);
  });
});

describe("S-CH4b — getRevealedContact fetches ONLY owned-channel child ciphertext (narrowing rider)", () => {
  let mailClaimId = "";

  beforeAll(async () => {
    // A live email child owned by an EMAIL-only claim (no phone claim). Gate-on, the reveal read must STILL
    // fetch + decrypt the OWNED email channel (the narrowing must not skip it), while the UNOWNED phone channel
    // is never fetched and stays absent — output is identical to fetching both, the fetch is merely narrower.
    mailClaimId = await seedChildOnlyEmail(tOn, wsOn, "MailClaim", "mail.claim@narrow.io", "narrow.io");
    await admin`
      INSERT INTO contact_reveals (tenant_id, workspace_id, contact_id, revealed_by_user_id, reveal_type, data_source, credits_consumed)
      VALUES (${tOn}, ${wsOn}, ${mailClaimId}, ${ownerOn}, 'email', 'internal', 0)`;
  }, 60_000);

  test("email-only claim: owned email values present (from child); unowned phone omitted", async () => {
    const r = await core.getRevealedContact(scope(tOn, wsOn), mailClaimId);
    expect(r).not.toBeNull();
    // OWNED channel: fetched + decrypted from the child (the narrowing kept the owned fetch — the regression guard).
    expect(r!.emails).toBeDefined();
    expect(r!.emails!.length).toBe(1);
    expect(r!.emails![0].value).toBe("mail.claim@narrow.io");
    expect(r!.emails![0].isPrimary).toBe(true);
    // UNOWNED channel: no phone claim ⇒ the phone child is never fetched and the arrays/scalar stay absent/null.
    expect(r!.phones).toBeUndefined();
    expect(r!.phone).toBeNull();
  });
});
