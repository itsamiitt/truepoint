// Acceptance tests T1–T11 from cascade-graph/guides/07 §3, plus the fusion rule.
// Runs against PGlite — a real Postgres engine in-process, so partial unique
// indexes, ARRAY types and DISTINCT ON behave exactly as they will in production.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type DbClient, createPgliteClient } from "../src/client";
import { closeEdge, evidenceFor } from "../src/edges";
import { fuseConfidence } from "../src/fusion";
import { applyMigrations } from "../src/migrate";
import { organizationRepository } from "../src/repositories/organizationRepository";
import { personRepository } from "../src/repositories/personRepository";
import { technologyRelationRepository } from "../src/repositories/technologyRelationRepository";
import { technologyRepository } from "../src/repositories/technologyRepository";
import { EXAMPLE_IDS as E, seedExample, seedId } from "../src/seed";

let db: DbClient;

beforeAll(async () => {
  db = await createPgliteClient();
  await applyMigrations(db);
  await seedExample(db);
}, 180_000);

afterAll(async () => {
  await db?.close();
});

const names = (rows: { canonical_name: string }[]) => rows.map((r) => r.canonical_name).sort();

describe("T1 — develops and uses are disjoint", () => {
  test("Sage's portfolio never contains WordPress", async () => {
    const built = await technologyRelationRepository.technologiesForOrg(db, E.orgSage, "develops");
    expect(built.some((r) => r.technology_id === E.techWordpress)).toBe(false);
  });

  test("Sage's stack never contains Sage Intacct", async () => {
    const runs = await technologyRelationRepository.technologiesForOrg(db, E.orgSage, "uses");
    expect(runs.some((r) => r.technology_id === E.techIntacct)).toBe(false);
  });
});

describe("T2/T3 — the two answers, from the same node", () => {
  test("what did Sage BUILD", async () => {
    const built = await technologyRelationRepository.technologiesForOrg(db, E.orgSage, "develops");
    expect(names(built)).toEqual(["Sage 50", "Sage Intacct", "Sage X3"]);
  });

  test("what does Sage RUN", async () => {
    const runs = await technologyRelationRepository.technologiesForOrg(db, E.orgSage, "uses");
    expect(names(runs)).toEqual(["Google Analytics", "Google Keyword Planner", "WordPress"]);
  });

  test("what did Google build", async () => {
    const built = await technologyRelationRepository.technologiesForOrg(
      db,
      E.orgGoogle,
      "develops",
    );
    expect(names(built)).toEqual(["Google Analytics", "Google Keyword Planner"]);
  });

  test("usage rows carry detection provenance; develops rows do not", async () => {
    const [wp] = await technologyRelationRepository.technologiesForOrg(db, E.orgSage, "uses", {
      limit: 100,
    });
    const runs = await technologyRelationRepository.technologiesForOrg(db, E.orgSage, "uses", {
      limit: 100,
    });
    const wordpress = runs.find((r) => r.technology_id === E.techWordpress);
    expect(wordpress?.detection_method).toBe("webappanalyzer");
    expect(wordpress?.detected_on_domain).toBe("sage.com");
    expect(wp).toBeDefined();

    const built = await technologyRelationRepository.technologiesForOrg(db, E.orgSage, "develops");
    expect(built.every((r) => r.detection_method === null)).toBe(true);
    expect(built.find((r) => r.technology_id === E.techIntacct)?.is_primary_product).toBe(true);
  });
});

describe("T4 — colleagues resolve (Alex ↔ Siya via Sage)", () => {
  test("who works at Sage returns both", async () => {
    const people = await personRepository.peopleAtOrg(db, E.orgSage, {
      relationship: "employee",
      current: true,
    });
    expect(people.map((p) => p.full_name).sort()).toEqual(["Alex Mehta", "Siya Rao"]);
  });

  test("Alex's colleagues = Siya", async () => {
    const colleagues = await personRepository.colleagues(db, E.pnAlex);
    expect(colleagues.map((c) => c.full_name)).toEqual(["Siya Rao"]);
  });
});

describe("T5 — education resolves to a school org, not free text", () => {
  test("Alex studied at SPPU, and SPPU is an organization of kind school", async () => {
    const educations = await personRepository.educations(db, E.pnAlex);
    expect(educations).toHaveLength(1);
    expect(educations[0]?.org_id).toBe(E.orgSppu);
    expect(educations[0]?.school_name).toBe("Savitribai Phule Pune University");

    const sppu = await organizationRepository.getById(db, E.orgSppu);
    expect(sppu?.org_kind).toBe("school");
  });

  test("alumni of SPPU — derived from dates, not an asserted type", async () => {
    const alumni = await personRepository.peopleWithEducationAtOrg(db, E.orgSppu, {
      status: "completed",
    });
    expect(alumni.map((p) => p.full_name)).toEqual(["Alex Mehta"]);

    const current = await personRepository.peopleWithEducationAtOrg(db, E.orgSppu, {
      status: "current",
    });
    expect(current).toHaveLength(0);
  });
});

describe("T6 — 'who made what Sage runs' composes (uses → creator)", () => {
  test("Google is the creator behind Sage's Google tools", async () => {
    const runs = await technologyRelationRepository.technologiesForOrg(db, E.orgSage, "uses");
    const creators = await technologyRelationRepository.creatorsForTechnologies(
      db,
      runs.map((r) => r.technology_id),
    );
    const byTech = new Map(creators.map((c) => [c.technology_id, c.display_name]));
    expect(byTech.get(E.techGa)).toBe("Google");
    expect(byTech.get(E.techGkp)).toBe("Google");
    expect(byTech.get(E.techWordpress)).toBe("Automattic");
  });
});

describe("T7 — acquisition history is preserved", () => {
  test("Intacct Inc. created Sage Intacct; Sage owns it now", async () => {
    const vendors = await technologyRelationRepository.vendorsForTechnology(db, E.techIntacct);
    const creator = vendors.find((v) => v.relationship === "creator");
    const owner = vendors.find((v) => v.relationship === "current_owner" && v.valid_to === null);
    expect(creator?.legal_name).toBe("Intacct Inc.");
    expect(owner?.legal_name).toBe("Sage Group plc");
  });

  test("as-of 2016, the owner was Intacct Inc. — not Sage", async () => {
    const vendors = await technologyRelationRepository.vendorsForTechnology(
      db,
      E.techIntacct,
      "2016-01-01",
    );
    const owners = vendors.filter((v) => v.relationship !== "creator");
    expect(owners).toHaveLength(1);
    expect(owners[0]?.legal_name).toBe("Intacct Inc.");
  });
});

describe("T9 — provenance present on every edge", () => {
  test("no relationship row lacks confidence or source", async () => {
    for (const table of [
      "person_positions",
      "person_educations",
      "org_technology_relations",
      "technology_vendors",
    ]) {
      const [row] = await db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM ${table} WHERE confidence IS NULL OR source_id IS NULL`,
      );
      expect(row?.n).toBe("0");
    }
  });

  test("evidence trail is readable by edge id alone (prefix routing)", async () => {
    const ev = await evidenceFor(db, E.posAlexSage);
    expect(ev.edgeTable).toBe("person_positions");
    expect(ev.attestations).toHaveLength(2);
    expect(ev.attestations[0]?.raw_assertion).toContain("Alex Mehta");
  });
});

describe("fusion — dedupe → dampen → combine (04 §1)", () => {
  test("two independent sources fuse to 0.910, not naive 0.985", () => {
    expect(
      fuseConfidence([
        { sourceId: "a", confidence: 0.9 },
        { sourceId: "b", confidence: 0.85 },
      ]),
    ).toBe(0.91);
  });

  test("a correlated re-sighting from the SAME source does not compound", () => {
    const once = fuseConfidence([{ sourceId: "a", confidence: 0.9 }]);
    const twice = fuseConfidence([
      { sourceId: "a", confidence: 0.9 },
      { sourceId: "a", confidence: 0.9 },
    ]);
    expect(twice).toBe(once);
  });

  test("the seeded position carries the fused value", async () => {
    const ev = await evidenceFor(db, E.posAlexSage);
    expect(ev.fused).toBe(0.91);
  });
});

describe("T10 — re-adoption works (the partial unique earns its keep)", () => {
  test("close then re-open the same (org, tech, uses) triple", async () => {
    await closeEdge(db, E.relUseWordpress, new Date("2026-01-01T00:00:00Z"));

    await db.query(
      `INSERT INTO org_technology_relations (rel_id, org_id, technology_id, relationship_type,
        first_seen_at, last_seen_at, detection_method, detected_on_domain, source_id, confidence, valid_from)
       VALUES ($4,$1,$2,'uses','2026-06-01T00:00:00Z','2026-06-01T00:00:00Z',
               'webappanalyzer','sage.com',$3,0.88,'2026-06-01T00:00:00Z')`,
      [E.orgSage, E.techWordpress, E.srcWeb, seedId("rel", "READOPTWP")],
    );

    const [row] = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM org_technology_relations
       WHERE org_id = $1 AND technology_id = $2 AND relationship_type = 'uses'`,
      [E.orgSage, E.techWordpress],
    );
    expect(row?.n).toBe("2"); // one closed + one open

    const open = await technologyRelationRepository.technologiesForOrg(db, E.orgSage, "uses");
    expect(names(open)).toEqual(["Google Analytics", "Google Keyword Planner", "WordPress"]);
  });

  test("a SECOND open row for the same triple is rejected by uniq_otr_open", async () => {
    let rejected = false;
    try {
      await db.query(
        `INSERT INTO org_technology_relations (rel_id, org_id, technology_id, relationship_type,
          source_id, confidence, valid_from)
         VALUES ($4,$1,$2,'uses',$3,0.5,'2026-07-01T00:00:00Z')`,
        [E.orgSage, E.techWordpress, E.srcWeb, seedId("rel", "DUPEWP")],
      );
    } catch (err) {
      rejected = true;
      expect(String(err)).toMatch(/uniq_otr_open|duplicate key/i);
    }
    expect(rejected).toBe(true);
  });

  test("the displacement feed surfaces the closed row (05 §4)", async () => {
    const dropped = await technologyRelationRepository.orgsForTechnology(
      db,
      E.techWordpress,
      "uses",
      {
        status: "closed",
        closedSince: "2025-01-01",
      },
    );
    expect(dropped.map((d) => d.legal_name)).toContain("Sage Group plc");
  });
});

describe("T11 — resolution substrate", () => {
  test("alias lookup resolves SPPU", async () => {
    const matches = await organizationRepository.candidatesByName(db, "SPPU");
    expect(matches[0]?.org.org_id).toBe(E.orgSppu);
    expect(matches[0]?.match_confidence).toBeGreaterThan(0.9);
  });

  test("identifier lookup is deterministic for sage.com", async () => {
    const org = await organizationRepository.byIdentifier(db, "domain", "sage.com");
    expect(org?.org_id).toBe(E.orgSage);
  });

  test("technology alias resolves GA4 → Google Analytics", async () => {
    const matches = await technologyRepository.resolve(db, { name: "GA4" });
    expect(matches[0]?.tech.technology_id).toBe(E.techGa);
  });
});

describe("time travel — as_of on relationship reads", () => {
  test("Sage's stack on 2023-01-01 excluded WordPress (first seen 2023-02-10)", async () => {
    const stack = await technologyRelationRepository.technologiesForOrg(db, E.orgSage, "uses", {
      asOf: "2023-01-01",
    });
    expect(names(stack)).toEqual(["Google Analytics"]);
  });
});
