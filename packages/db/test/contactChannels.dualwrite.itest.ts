// contactChannels.dualwrite.itest.ts — S-CH2's test gate (import-and-data-model-redesign 05 §Testing,
// 15 §T-P3): the T-CH DUAL-WRITE PARITY harness + the CH-INV-1 consistency, collision, shared-phone, and
// per-contact-cap proofs, end to end against a real Postgres 16 (Testcontainers by default, or an external
// server via ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process (db client + waterfall breakers
// are module singletons): `bun test ./packages/db/test/contactChannels.dualwrite.itest.ts`
//
// GATE ARMS: the frozen config env cannot be flipped mid-process, so CHANNEL_DUAL_WRITE="true" is set for
// the WHOLE process and the on/off comparison rides the PER-TENANT flag half of the dual gate: tenant OFF
// keeps the 0059 seed (off/off ⇒ effective off), tenant ON gets a tenant_feature_flags override. This is
// the stronger parity arm anyway — it proves the flag layer alone holds the line even with the env layer
// armed. (The env-off arm is a short-circuit `if (!env.CHANNEL_DUAL_WRITE) return false` — zero queries by
// construction, covered by reading the code path; asserted here indirectly: the OFF tenant performs zero
// child writes.)
//
// T-CH (test 1+2): the SAME import → overwrite re-import → fake-provider enrich sequence through both
// tenants ⇒ IDENTICAL flat contact end-state (dual-write adds child rows, never behavior) — gate-off
// additionally writes ZERO child rows; gate-on the child rows satisfy CH-INV-1 (the flat channel columns
// are a byte-exact projection of the live is_primary child row: blind-index/ciphertext byte equality
// checked IN SQL). Test 3 pins the 05 §3.3 no-flip rule (enrichment appends a secondary; the flat-wins
// divergence it leaves is the documented S-CH5 repair case). Tests 4–6: email ws-unique collision ⇒
// `collision` outcome (never an error, no row moved); the same phone on two contacts is LEGAL (05 §2.2
// asymmetry); the 26th value ⇒ `capped`. Test 7: the verify op mirrors a grade onto the primary row.
//
// Core fns are imported via the RELATIVE core barrel (../../core/src/index.ts), NOT as a db dep —
// importing @leadwolf/core into a packages/db test is a build cycle (the fieldProvenancePin precedent).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type EnrichmentProvider = import("../../core/src/index.ts").EnrichmentProvider;
type Db = typeof import("@leadwolf/db");

const PROVIDER_NAME = "zoominfo"; // valid sourceName ⇒ the full persist path incl. source_imports lineage

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;
let db: Db;

let tenantOff = "";
let wsOff = "";
let ownerOff = "";
let tenantOn = "";
let wsOn = "";
let ownerOn = "";

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  jobTitle: "Title",
  phone: "Phone",
  locationCountry: "Country",
};

// Row 1: email + national-format phone + ISO-2 country (E.164 derivable). Row 2: email only.
const ROWS = [
  {
    Email: "jane@acme.com",
    "First Name": "Jane",
    Title: "Old",
    Phone: "(415) 555-2671",
    Country: "US",
  },
  { Email: "john@acme.com", "First Name": "John", Title: "Old", Phone: "", Country: "" },
];

async function seedTenantWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  return { tenantId, workspaceId: (w as { id: string }).id, ownerId };
}

interface FlatRow {
  id: string;
  first_name: string | null;
  job_title: string | null;
  email_domain: string | null;
  email_status: string;
  email_bi_hex: string | null;
  has_phone: boolean;
}

/** The masked-comparable flat end-state per workspace, ordered by first_name (deterministic). */
async function flatState(workspaceId: string): Promise<FlatRow[]> {
  const rows = await admin`
    SELECT id, first_name, job_title, email_domain, email_status,
           encode(email_blind_index, 'hex') AS email_bi_hex,
           (phone_enc IS NOT NULL) AS has_phone
    FROM contacts WHERE workspace_id = ${workspaceId} ORDER BY first_name`;
  return rows as unknown as FlatRow[];
}

async function childCounts(workspaceId: string): Promise<{ emails: number; phones: number }> {
  const [e] = await admin`
    SELECT count(*)::int AS n FROM contact_emails WHERE workspace_id = ${workspaceId}`;
  const [p] = await admin`
    SELECT count(*)::int AS n FROM contact_phones WHERE workspace_id = ${workspaceId}`;
  return { emails: (e as { n: number }).n, phones: (p as { n: number }).n };
}

async function contactIdByName(workspaceId: string, firstName: string): Promise<string> {
  const [r] = await admin`
    SELECT id FROM contacts WHERE workspace_id = ${workspaceId} AND first_name = ${firstName}`;
  return (r as { id: string }).id;
}

/** A phone-filling fake provider (waterfall.test.ts's `fake` shape; zero cost, always hits). */
function phoneProvider(value: string): EnrichmentProvider {
  return {
    name: PROVIDER_NAME,
    trust: 0.9,
    capabilities: ["contact.phone"],
    estimateCostMicros: () => 0,
    enrich: () =>
      Promise.resolve({
        fields: [{ field: "phone", value }],
        rawPayload: { from: PROVIDER_NAME },
        costMicros: 0,
        status: "hit",
      }),
  };
}

/** Run the identical writer sequence T-CH compares: import create → overwrite re-import (matched update,
 *  changed scalar, same channels) → enrich a phone onto the email-only contact (John). */
async function runSequence(scope: { tenantId: string; workspaceId: string }, ownerId: string) {
  const first = await core.runImport({
    scope,
    importedByUserId: ownerId,
    sourceName: "manual",
    mapping: MAPPING,
    conflictPolicy: "overwrite",
    rows: ROWS,
  });
  expect(first.created).toBe(2);

  const second = await core.runImport({
    scope,
    importedByUserId: ownerId,
    sourceName: "manual",
    mapping: MAPPING,
    conflictPolicy: "overwrite",
    rows: ROWS.map((r) => ({ ...r, Title: "New" })), // changed scalar ⇒ new content hash ⇒ matched update
  });
  expect(second.matched).toBe(2);

  const johnId = await contactIdByName(scope.workspaceId, "John");
  const enriched = await core.enrichContact({
    scope,
    contactId: johnId,
    fields: ["phone"],
    providers: [phoneProvider("+1 212 555 0100")],
    requestedByUserId: ownerId,
  });
  expect(enriched.status).toBe("enriched");
}

beforeAll(async () => {
  dbHandle = await startItestDb("contact_channels_dualwrite");
  // env BEFORE the config/db singletons load. CHANNEL_DUAL_WRITE arms the ENV half for the whole process;
  // the per-tenant flag half drives the on/off arms (see header).
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.CHANNEL_DUAL_WRITE = "true";
  process.env.ENRICH_DAILY_BUDGET_MICROS = "1000000000";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantOff, workspaceId: wsOff, ownerId: ownerOff } =
    await seedTenantWorkspace("acme-off"));
  ({ tenantId: tenantOn, workspaceId: wsOn, ownerId: ownerOn } =
    await seedTenantWorkspace("acme-on"));
  // The ON tenant's per-tenant override; the OFF tenant keeps the 0059 seed (off/off ⇒ effective off).
  await admin`
    INSERT INTO tenant_feature_flags (flag_key, tenant_id, enabled)
    VALUES ('channels_dual_write', ${tenantOn}, true)`;

  core = await import("../../core/src/index.ts");
  db = await import("@leadwolf/db");
  core.resetBreakers();

  // The shared sequence, both arms — every later test reads its end state.
  await runSequence({ tenantId: tenantOff, workspaceId: wsOff }, ownerOff);
  await runSequence({ tenantId: tenantOn, workspaceId: wsOn }, ownerOn);
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const scopeOn = () => ({ tenantId: tenantOn, workspaceId: wsOn });

describe("T-CH — dual-write parity (gate off vs on ⇒ identical flat state; child rows only gate-on)", () => {
  test("the identical import/overwrite/enrich sequence lands an identical flat end-state in both arms", async () => {
    const off = await flatState(wsOff);
    const on = await flatState(wsOn);
    expect(off.length).toBe(2);
    expect(on.length).toBe(2);
    for (let i = 0; i < off.length; i++) {
      const a = off[i]!;
      const b = on[i]!;
      expect(b.first_name).toBe(a.first_name);
      expect(b.job_title).toBe(a.job_title); // 'New' — the overwrite applied identically
      expect(b.email_domain).toBe(a.email_domain);
      expect(b.email_status).toBe(a.email_status);
      expect(b.email_bi_hex).toBe(a.email_bi_hex); // deterministic HMAC ⇒ byte-comparable across arms
      expect(b.has_phone).toBe(a.has_phone);
    }
    // Both arms hold the same phone plaintext (ciphertexts differ per encryption — decrypt to compare).
    const [offJane] = await admin`
      SELECT phone_enc FROM contacts WHERE workspace_id = ${wsOff} AND first_name = 'Jane'`;
    const [onJane] = await admin`
      SELECT phone_enc FROM contacts WHERE workspace_id = ${wsOn} AND first_name = 'Jane'`;
    expect(core.decryptPii((onJane as { phone_enc: Uint8Array }).phone_enc)).toBe(
      core.decryptPii((offJane as { phone_enc: Uint8Array }).phone_enc),
    );
  });

  test("gate-off (flag-off tenant): ZERO child rows were written by the whole sequence", async () => {
    expect(await childCounts(wsOff)).toEqual({ emails: 0, phones: 0 });
  });

  test("gate-on: child rows exist and satisfy CH-INV-1 (flat ≡ live is_primary child row, byte-compared in SQL)", async () => {
    // One live primary email per contact, blind-index byte-equal to the flat cache; re-import deduped
    // (2 contacts ⇒ 2 email rows, not 4 — first_seen_at survives re-imports).
    const emailRows = await admin`
      SELECT c.first_name, ce.is_primary,
             (ce.blind_index = c.email_blind_index) AS bi_matches_flat,
             (ce.value_enc = c.email_enc) AS enc_matches_flat,
             ce.email_domain, ce.status, ce.source, ce.type,
             (ce.source_import_id IS NOT NULL) AS has_lineage
      FROM contact_emails ce JOIN contacts c ON c.id = ce.contact_id
      WHERE ce.workspace_id = ${wsOn} AND ce.deleted_at IS NULL ORDER BY c.first_name`;
    expect(emailRows.length).toBe(2);
    for (const r of emailRows as unknown as Array<Record<string, unknown>>) {
      expect(r.is_primary).toBe(true);
      expect(r.bi_matches_flat).toBe(true); // CH-INV-1's checkable form
      expect(r.enc_matches_flat).toBe(true); // primary byte-refresh tracked the re-import's fresh bytes
      expect(r.email_domain).toBe("acme.com");
      expect(r.source).toBe("import:manual");
      expect(r.type).toBe("work");
      expect(r.has_lineage).toBe(true); // source_imports FK stamped from the same landing tx
    }

    // Jane's import phone: primary, value_enc BYTE-EQUAL to the flat phone_enc (same ciphertext object
    // written in the same tx), E.164 derived (US hint from the row's ISO-2 country), hint recorded.
    const [janePhone] = await admin`
      SELECT cp.is_primary, (cp.value_enc = c.phone_enc) AS enc_matches_flat,
             (cp.e164_blind_index IS NOT NULL) AS parsed, cp.country_hint, cp.source
      FROM contact_phones cp JOIN contacts c ON c.id = cp.contact_id
      WHERE cp.workspace_id = ${wsOn} AND c.first_name = 'Jane' AND cp.deleted_at IS NULL`;
    const jp = janePhone as unknown as Record<string, unknown>;
    expect(jp.is_primary).toBe(true);
    expect(jp.enc_matches_flat).toBe(true);
    expect(jp.parsed).toBe(true);
    expect(jp.country_hint).toBe("US");
    expect(jp.source).toBe("import:manual");

    // John's enriched phone: FIRST phone value ⇒ primary + flat projection (CH-INV-1 holds), provider
    // row provenance.
    const [johnPhone] = await admin`
      SELECT cp.is_primary, (cp.value_enc = c.phone_enc) AS enc_matches_flat, cp.source
      FROM contact_phones cp JOIN contacts c ON c.id = cp.contact_id
      WHERE cp.workspace_id = ${wsOn} AND c.first_name = 'John' AND cp.deleted_at IS NULL`;
    const jo = johnPhone as unknown as Record<string, unknown>;
    expect(jo.is_primary).toBe(true);
    expect(jo.enc_matches_flat).toBe(true);
    expect(jo.source).toBe(`provider:${PROVIDER_NAME}`);
  });
});

describe("05 §3.3/§6 — an existing primary is never flipped; enrichment appends a secondary", () => {
  test("enriching a SECOND phone onto Jane appends a secondary; the import primary survives", async () => {
    const janeId = await contactIdByName(wsOn, "Jane");
    const result = await core.enrichContact({
      scope: scopeOn(),
      contactId: janeId,
      fields: ["phone"],
      providers: [phoneProvider("+1 646 555 0199")],
      requestedByUserId: ownerOn,
    });
    expect(result.status).toBe("enriched");

    const rows = await admin`
      SELECT is_primary, source, encode(e164_blind_index, 'hex') AS e164_hex
      FROM contact_phones
      WHERE contact_id = ${janeId} AND deleted_at IS NULL ORDER BY is_primary DESC`;
    expect(rows.length).toBe(2);
    const [primary, secondary] = rows as unknown as Array<Record<string, unknown>>;
    expect(primary!.is_primary).toBe(true);
    expect(primary!.source).toBe("import:manual"); // the ORIGINAL primary — never flipped by enrichment
    expect(secondary!.is_primary).toBe(false);
    expect(secondary!.source).toBe(`provider:${PROVIDER_NAME}`);
    // Documented S-CH2 divergence (doc 16 drift row): the SHIPPED enrich still overwrote the FLAT phone,
    // so flat now holds the secondary's value until the S-CH5 flat-wins sweep repairs — asserted honestly.
    const [flat] = await admin`SELECT phone_enc FROM contacts WHERE id = ${janeId}`;
    expect(core.decryptPii((flat as { phone_enc: Uint8Array }).phone_enc)).toBe("+1 646 555 0199");
  });
});

describe("05 §2.2 — collision semantics at the applyChannelWrite layer", () => {
  test("an email VALUE live on another contact ⇒ `collision` outcome, no row moved, no error", async () => {
    const janeId = await contactIdByName(wsOn, "Jane");
    const johnId = await contactIdByName(wsOn, "John");
    // Jane's live email bytes, replayed against John (ws-unique identity says: resolve, don't copy).
    const [janeEmail] = await admin`
      SELECT value_enc, blind_index, email_domain FROM contact_emails
      WHERE contact_id = ${janeId} AND deleted_at IS NULL`;
    const je = janeEmail as { value_enc: Uint8Array; blind_index: Uint8Array; email_domain: string };

    const outcome = await db.withTenantTx(scopeOn(), (tx) =>
      db.contactChannelRepository.applyChannelWrite(tx, scopeOn(), {
        kind: "email_upsert",
        contactId: johnId,
        value: {
          valueEnc: je.value_enc,
          blindIndex: je.blind_index,
          emailDomain: je.email_domain,
          source: "import:manual",
        },
      }),
    );
    expect(outcome.result).toBe("collision");
    const [n] = await admin`
      SELECT count(*)::int AS n FROM contact_emails
      WHERE contact_id = ${johnId} AND deleted_at IS NULL`;
    expect((n as { n: number }).n).toBe(1); // John still has exactly his own email row
  });

  test("the SAME phone on two contacts is legal (per-contact unique only — shared HQ lines)", async () => {
    const janeId = await contactIdByName(wsOn, "Jane");
    const johnId = await contactIdByName(wsOn, "John");
    const hq = core.buildPhoneChannelValue({
      cleaned: "+1 (312) 555-0000",
      phoneEnc: core.encryptPii("+1 (312) 555-0000"),
    });
    for (const contactId of [janeId, johnId]) {
      const outcome = await db.withTenantTx(scopeOn(), (tx) =>
        db.contactChannelRepository.applyChannelWrite(tx, scopeOn(), {
          kind: "phone_upsert",
          contactId,
          value: { ...hq, type: "hq", source: "import:manual" },
        }),
      );
      expect(outcome.result).toBe("inserted");
      if (outcome.result === "inserted") expect(outcome.becamePrimary).toBe(false); // both had primaries
    }
    const shared = await admin`
      SELECT count(DISTINCT contact_id)::int AS n FROM contact_phones
      WHERE workspace_id = ${wsOn} AND blind_index = ${Buffer.from(hq.blindIndex)}
        AND deleted_at IS NULL`;
    expect((shared[0] as { n: number }).n).toBe(2);
  });
});

describe("05 §Misuse — the per-contact cap (25) skips + reports, never errors", () => {
  test("the 26th distinct email on one contact returns `capped`; 25 live rows remain", async () => {
    // A fresh, channel-less contact (admin-seeded; the cap path is exercised at the repository layer).
    const [c] = await admin`
      INSERT INTO contacts (tenant_id, workspace_id, first_name)
      VALUES (${tenantOn}, ${wsOn}, ${"Cappy"}) RETURNING id`;
    const contactId = (c as { id: string }).id;

    let capped = 0;
    for (let i = 0; i < 26; i++) {
      const email = `cap${i}@cap.test`;
      const outcome = await db.withTenantTx(scopeOn(), (tx) =>
        db.contactChannelRepository.applyChannelWrite(tx, scopeOn(), {
          kind: "email_upsert",
          contactId,
          value: {
            valueEnc: core.encryptPii(email),
            blindIndex: core.blindIndex(email),
            emailDomain: "cap.test",
            source: "import:manual",
          },
        }),
      );
      if (outcome.result === "capped") capped++;
    }
    expect(capped).toBe(1);
    const [n] = await admin`
      SELECT count(*)::int AS n FROM contact_emails
      WHERE contact_id = ${contactId} AND deleted_at IS NULL`;
    expect((n as { n: number }).n).toBe(25);
    // Exactly one primary (the first) — the partial unique + designation rule both held under the loop.
    const [p] = await admin`
      SELECT count(*)::int AS n FROM contact_emails
      WHERE contact_id = ${contactId} AND is_primary AND deleted_at IS NULL`;
    expect((p as { n: number }).n).toBe(1);
  });
});

describe("verify ops — grades mirror onto the live primary row", () => {
  test("email_verify stamps status + last_verified_at on the primary; noop for a channel-less contact", async () => {
    const janeId = await contactIdByName(wsOn, "Jane");
    const at = new Date();
    const outcome = await db.withTenantTx(scopeOn(), (tx) =>
      db.contactChannelRepository.applyChannelWrite(tx, scopeOn(), {
        kind: "email_verify",
        contactId: janeId,
        status: "valid",
        lastVerifiedAt: at,
      }),
    );
    expect(outcome.result).toBe("verified");
    const [row] = await admin`
      SELECT status, (last_verified_at IS NOT NULL) AS stamped FROM contact_emails
      WHERE contact_id = ${janeId} AND is_primary AND deleted_at IS NULL`;
    expect((row as { status: string }).status).toBe("valid");
    expect((row as unknown as { stamped: boolean }).stamped).toBe(true);

    const [c] = await admin`
      INSERT INTO contacts (tenant_id, workspace_id, first_name)
      VALUES (${tenantOn}, ${wsOn}, ${"NoChannels"}) RETURNING id`;
    const noop = await db.withTenantTx(scopeOn(), (tx) =>
      db.contactChannelRepository.applyChannelWrite(tx, scopeOn(), {
        kind: "email_verify",
        contactId: (c as { id: string }).id,
        status: "valid",
        lastVerifiedAt: at,
      }),
    );
    expect(noop.result).toBe("noop");
  });
});
