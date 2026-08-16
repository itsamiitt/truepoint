// dsarLayerZero.itest.ts — the Phase 5 half of erasure the overlay fan-out was missing: the SHARED graph
// (06-roadmap Phase 5 "erasure = tombstone event + graph reprocess"; 09 "erasure honored across graph").
//
// The bug this pins is not that the old fan-out did nothing — it did the overlay correctly, and every
// assertion in compliance.itest.ts passed. It is that master_persons survived untouched, so the next import
// of the same person re-minted a live contact from a golden row that still existed: the subject reappeared,
// and only the global deny list stood between them and being sold again. Worse, the request reported
// `completed` while that was true — a false erasure claim, which is the one outcome a DSAR must never
// produce.
//
// Needs a real Postgres: the golden graph is system-owned and not readable by leadwolf_app at all, so both
// the fixtures and the assertions run on the privileged owner connection.
//
//   bun test ./packages/db/test/dsarLayerZero.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type CoreModule = typeof import("../../core/src/index.ts");

const SUBJECT = "erase-me@acme.com";
const BYSTANDER = "keep-me@acme.com";

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: CoreModule;

let tenantId = "";
let wsId = "";
let subjectPersonId = "";
let bystanderPersonId = "";

beforeAll(async () => {
  dbHandle = await startItestDb("dsarLayerZero");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);
  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES ('acme','acme') RETURNING id`;
  tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('owner@acme.test') RETURNING id`;
  const owner = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner)
              VALUES (${tenantId}, ${owner}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, 'acme', 'acme', true, ${owner}) RETURNING id`;
  wsId = (w as { id: string }).id;

  core = await import("../../core/src/index.ts");
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

/** Seed a golden person + email facet, and one overlay contact bridged to it. */
async function seedSubject(email: string, linkedin: string): Promise<[string, string]> {
  const bi = core.blindIndex(email.trim().toLowerCase());
  const [mp] = await admin`
    INSERT INTO master_persons (linkedin_public_id, has_email, has_phone, full_name,
                                headline, summary, location_raw)
    VALUES (${linkedin}, true, false, ${`Person ${linkedin}`},
            'A headline', 'A summary.', 'Somewhere, USA') RETURNING id`;
  const personId = (mp as { id: string }).id;
  await admin`INSERT INTO master_emails (master_person_id, email_blind_index, email_domain)
              VALUES (${personId}, ${bi}, 'acme.com')`;
  // A person-subject signal (master_signals, 0103). A dated career event is personal data even though it
  // carries no contact value, so erasure has to reach it — and the residual scan has to be able to see it.
  await admin`INSERT INTO master_signals (subject_type, subject_id, type_code, observed_at)
              VALUES ('person', ${personId}, 'job_change', now())`;
  // External identifier rows (0104, fed by the 0113 landing) + subject-authored stint prose (0112) — both
  // new erasure surfaces the fan-out must reach: a surviving identifier re-links the subject on the next
  // ingest; a stint description is prose the subject wrote.
  await admin`INSERT INTO master_person_identifiers (master_person_id, id_type, id_value)
              VALUES (${personId}, 'linkedin_member_urn', ${`urn-${linkedin}`})`;
  // Multi-value attributes (0116) — personal data the fan-out must delete, identifier-row class.
  await admin`INSERT INTO master_person_skills (master_person_id, skill) VALUES (${personId}, 'SQL')`;
  await admin`INSERT INTO master_person_languages (master_person_id, name, proficiency)
              VALUES (${personId}, 'English', 'PROFESSIONAL_WORKING')`;
  await admin`INSERT INTO master_employment (master_person_id, company_name_raw, company_name_normalized,
                                             title, location, description, is_current)
              VALUES (${personId}, 'Acme Inc', 'acme inc', 'VP', 'HQ, USA', 'I did things.', true)`;
  const [c] = await admin`
    INSERT INTO contacts (tenant_id, workspace_id, first_name, email_blind_index, email_domain,
                          email_enc, master_person_id)
    VALUES (${tenantId}, ${wsId}, ${linkedin}, ${bi}, 'acme.com', '\\x00'::bytea, ${personId})
    RETURNING id`;
  return [personId, (c as { id: string }).id];
}

describe("DSAR erasure reaches Layer 0", () => {
  test("the golden node is suppressed, its channel facets dropped, and a tombstone event appended", async () => {
    // Assigned via a named local rather than a bare `[x] = ...` destructure: two of those on consecutive
    // lines parse as an index expression on the first line's result, which is how this file silently seeded
    // nothing and reported a uuid error three tests later.
    const subject = await seedSubject(SUBJECT, "erase-me");
    subjectPersonId = subject[0];
    const bystander = await seedSubject(BYSTANDER, "keep-me");
    bystanderPersonId = bystander[0];

    // A COMPANY-subject signal carrying the SUBJECT'S OWN id as subject_id. Contrived on purpose: it means
    // the only thing that can protect it from the erasure is the `subject_type = 'person'` discriminator,
    // so the guard is tested rather than merely present.
    await admin`INSERT INTO master_signals (subject_type, subject_id, type_code, observed_at)
                VALUES ('company', ${subjectPersonId}, 'funding_round', now())`;

    const requestId = await core.createDsarRequest("delete", SUBJECT);
    const result = await core.deleteFanout(requestId);

    expect(result.copiesErased).toBe(1);
    expect(result.masterPersonsSuppressed).toBe(1);

    const [p] = await admin`
      SELECT is_suppressed, has_email, full_name, linkedin_public_id
        FROM master_persons WHERE id = ${subjectPersonId}`;
    const person = p as Record<string, unknown>;
    expect(person.is_suppressed).toBe(true);
    expect(person.has_email).toBe(false);
    // The name goes too. It is the field that makes a suppressed row still identify a person.
    expect(person.full_name).toBeNull();
    expect(person.linkedin_public_id).toBeNull();

    // The 0112 self-description columns go with it — headline/summary/location_raw identify a person as
    // surely as the name does.
    const [prof] = await admin`
      SELECT headline, summary, location_raw FROM master_persons WHERE id = ${subjectPersonId}`;
    const profile = prof as Record<string, unknown>;
    expect(profile.headline).toBeNull();
    expect(profile.summary).toBeNull();
    expect(profile.location_raw).toBeNull();

    // Identifier rows deleted (recognition belongs in the deny list, not the golden record) …
    const [idents] = await admin`
      SELECT count(*)::int AS n FROM master_person_identifiers
       WHERE master_person_id = ${subjectPersonId}`;
    expect((idents as { n: number }).n).toBe(0);

    // … the multi-value attribute rows (0116) go with them — a skill/language list is personal data …
    const [attrs] = await admin`
      SELECT (SELECT count(*) FROM master_person_skills    WHERE master_person_id = ${subjectPersonId})
           + (SELECT count(*) FROM master_person_languages WHERE master_person_id = ${subjectPersonId})
             AS n`;
    expect(Number((attrs as { n: number | string }).n)).toBe(0);

    // … and the stint keeps its business fact but loses the subject-authored prose.
    const [stint] = await admin`
      SELECT title, location, description FROM master_employment
       WHERE master_person_id = ${subjectPersonId}`;
    const stintRow = stint as Record<string, unknown>;
    expect(stintRow.title).toBe("VP");
    expect(stintRow.location).toBeNull();
    expect(stintRow.description).toBeNull();

    // The email facet is gone, blind index and all. Keeping the index would leave the graph able to
    // recognise the subject on sight forever; recognition belongs in the deny list, not the golden record.
    const [e] = await admin`
      SELECT count(*)::int AS n FROM master_emails WHERE master_person_id = ${subjectPersonId}`;
    expect((e as { n: number }).n).toBe(0);

    // The tombstone EVENT — appended, not a deletion of history. A projector replaying the stream has to
    // learn the tail is void; a deleted history would replay straight back into a live person.
    const [ev] = await admin`
      SELECT count(*)::int AS n FROM provenance_event
       WHERE entity_type = 'person' AND entity_id = ${subjectPersonId} AND action = 'tombstone'
         AND payload->>'requestId' = ${requestId}`;
    expect((ev as { n: number }).n).toBe(1);
  });

  test("the tombstone event carries the request id and NOTHING about the subject", async () => {
    // A tombstone that quoted what was erased would be a copy of the thing it erases.
    const [ev] = await admin`
      SELECT payload::text AS payload FROM provenance_event
       WHERE entity_id = ${subjectPersonId} AND action = 'tombstone' LIMIT 1`;
    const payload = (ev as { payload: string }).payload;
    expect(payload).not.toContain("erase-me@acme.com");
    expect(payload).not.toContain("acme.com");
  });

  test("the subject's person-subject signals are erased", async () => {
    // Before this was wired, the fan-out deleted the channel facets and left these behind — and, worse, the
    // residual scan did not count them, so the request still reported `completed`. A false completion claim
    // on the A-02 path is worse than the rows: the ≤72h SLA is measured against exactly that gate.
    const [s] = await admin`
      SELECT count(*)::int AS n FROM master_signals
       WHERE subject_type = 'person' AND subject_id = ${subjectPersonId}`;
    expect((s as { n: number }).n).toBe(0);
  });

  test("a COMPANY-subject signal survives — erasure is scoped by the discriminator", async () => {
    // master_signals is polymorphic. A funding round is a fact about a COMPANY that no person may erase, and
    // dropping `subject_type = 'person'` from the delete would silently destroy company intelligence on every
    // DSAR. Seeded with the subject's own id as the subject_id so ONLY the discriminator can save it.
    const [s] = await admin`
      SELECT count(*)::int AS n FROM master_signals
       WHERE subject_type = 'company' AND subject_id = ${subjectPersonId}`;
    expect((s as { n: number }).n).toBe(1);
  });

  test("a bystander's signals survive", async () => {
    const [s] = await admin`
      SELECT count(*)::int AS n FROM master_signals
       WHERE subject_type = 'person' AND subject_id = ${bystanderPersonId}`;
    expect((s as { n: number }).n).toBe(1);
  });

  test("a bystander in the same graph is untouched", async () => {
    // The find-everywhere query keys on the blind index. If it ever widened to a domain or a name, this is
    // the assertion that would notice — and a DSAR that erased the wrong people would be a worse incident
    // than one that erased nobody.
    const [p] = await admin`
      SELECT is_suppressed, full_name FROM master_persons WHERE id = ${bystanderPersonId}`;
    expect((p as { is_suppressed: boolean }).is_suppressed).toBe(false);
    expect((p as { full_name: string | null }).full_name).not.toBeNull();
    const [e] = await admin`
      SELECT count(*)::int AS n FROM master_emails WHERE master_person_id = ${bystanderPersonId}`;
    expect((e as { n: number }).n).toBe(1);
  });

  test("the request completes only because Layer 0 is clean too", async () => {
    const [r] = await admin`
      SELECT status, scope_report FROM dsar_requests WHERE
        subject_email_blind_index = ${core.blindIndex(SUBJECT)} ORDER BY requested_at DESC LIMIT 1`;
    expect((r as { status: string }).status).toBe("completed");
    const report = (r as { scope_report: Record<string, unknown> }).scope_report;
    expect(report.masterPersonsSuppressed).toBe(1);
    expect((report.verification as Record<string, number>).masterResiduals).toBe(0);
  });

  test("re-running is idempotent — no second tombstone, no duplicate suppression row", async () => {
    // suppressMasterPersons deletes the master_emails rows findMasterPersons resolves through, so a re-run
    // finds no persons and never reaches the append. The global suppression insert has its own guard.
    const requestId = await core.createDsarRequest("delete", SUBJECT);
    const again = await core.deleteFanout(requestId);
    expect(again.masterPersonsSuppressed).toBe(0);
    expect(again.completed).toBe(true);

    const [ev] = await admin`
      SELECT count(*)::int AS n FROM provenance_event
       WHERE entity_id = ${subjectPersonId} AND action = 'tombstone'`;
    expect((ev as { n: number }).n).toBe(1);

    const [sup] = await admin`
      SELECT count(*)::int AS n FROM suppression_list
       WHERE scope = 'global' AND match_type = 'email' AND email_blind_index = ${core.blindIndex(SUBJECT)}`;
    expect((sup as { n: number }).n).toBe(1);
  });

  test("an erasure for someone we hold nothing on still writes the deny list", async () => {
    // The forward-looking half. A subject we do not hold today will be in some future import; gating the
    // suppression on "did we find anything to erase right now" would make their request a no-op that
    // reports success and then quietly lets the next crawl re-acquire them.
    const stranger = "never-seen@nowhere.test";
    const requestId = await core.createDsarRequest("delete", stranger);
    const res = await core.deleteFanout(requestId);
    expect(res.copiesErased).toBe(0);
    expect(res.completed).toBe(true);

    const [sup] = await admin`
      SELECT count(*)::int AS n FROM suppression_list
       WHERE scope = 'global' AND email_blind_index = ${core.blindIndex(stranger)}`;
    expect((sup as { n: number }).n).toBe(1);
  });

  test("the ≤72h SLA clock is stamped at intake and breaches are findable", async () => {
    const { dsarRequestRepository, withPrivilegedTx } = await import("@leadwolf/db");
    const requestId = await core.createDsarRequest("access", "sla@acme.test");

    const row = await withPrivilegedTx((tx) => dsarRequestRepository.getById(tx, requestId));
    expect(row).not.toBeNull();
    const hours = (row!.dueAt.getTime() - row!.requestedAt.getTime()) / 3_600_000;
    expect(Math.round(hours)).toBe(72);

    // Nothing is overdue yet.
    const none = await withPrivilegedTx((tx) => dsarRequestRepository.findOverdue(tx, new Date()));
    expect(none.some((r) => r.id === requestId)).toBe(false);

    // A deadline column nothing queries is a comment with a type — this is the query that makes a missed
    // SLA visible. Asked from a future clock rather than by ageing the row, so the test states the rule.
    const future = new Date(Date.now() + 80 * 3_600_000);
    const overdue = await withPrivilegedTx((tx) => dsarRequestRepository.findOverdue(tx, future));
    expect(overdue.some((r) => r.id === requestId)).toBe(true);
    // Completed requests never appear, whenever they finished: breach is about work still owed.
    expect(overdue.every((r) => r.status !== "completed" && r.status !== "rejected")).toBe(true);
  });
});
