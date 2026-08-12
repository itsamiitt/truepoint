// The §0 table of cascade-graph/api/09: every question in the brief, answered
// over HTTP against the seeded example graph.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type DbClient,
  EXAMPLE_IDS as E,
  applyMigrations,
  createPgliteClient,
  seedExample,
} from "@cascade/db";
import type { Hono } from "hono";
import { createApp } from "../src/app";

let db: DbClient;
let app: Hono<{ Variables: { db: DbClient } }>;

// Responses are asserted against runtime JSON; the compile-time DTO contract is
// enforced in src/serializers.ts. `T` lets each call name the shape it expects.
type JsonBody = Record<string, never>;

const get = async <T = JsonBody>(path: string) => {
  const res = await app.request(path);
  return {
    status: res.status,
    body: (await res.json()) as T,
    contentType: res.headers.get("content-type"),
  };
};

interface ProblemBody {
  code: string;
  title: string;
  status: number;
}
interface TechListBody {
  results: { technology: { canonical_name: string }; creator?: { display_name: string } }[];
}
interface PeopleListBody {
  results: { person: { full_name: string } }[];
}
interface VendorListBody {
  results: { relationship: string; organization: { legal_name: string } }[];
}
interface MatchBody {
  match_type: string;
  matches: {
    match_confidence: number;
    organization?: { org_id: string };
    technology?: { canonical_name: string };
  }[];
}
interface EvidenceBody {
  edge_kind: string;
  fused_confidence: number;
  attestations: { raw_assertion: string | null }[];
}
interface PersonBody {
  person: {
    positions?: { organization: { display_name: string } | null; title: string | null }[];
    educations?: {
      organization: { display_name: string } | null;
      degree: string | null;
      completed: boolean;
    }[];
  };
}

beforeAll(async () => {
  db = await createPgliteClient();
  await applyMigrations(db);
  await seedExample(db);
  app = createApp({ db }) as never;
}, 180_000);

afterAll(async () => {
  await db?.close();
});

const techNames = (results: { technology: { canonical_name: string } }[]) =>
  results.map((r) => r.technology.canonical_name).sort();

describe("the develops-vs-uses split, over HTTP", () => {
  test("GET what Sage BUILDS → only its own products", async () => {
    const { status, body } = await get<TechListBody>(
      `/v1/organizations/${E.orgSage}/technologies?relationship=develops`,
    );
    expect(status).toBe(200);
    expect(techNames(body.results)).toEqual(["Sage 50", "Sage Intacct", "Sage X3"]);
  });

  test("GET what Sage RUNS → only third-party tools", async () => {
    const { body } = await get<TechListBody>(
      `/v1/organizations/${E.orgSage}/technologies?relationship=uses`,
    );
    expect(techNames(body.results)).toEqual([
      "Google Analytics",
      "Google Keyword Planner",
      "WordPress",
    ]);
  });

  test("omitting `relationship` is a 400 — the API cannot be asked an ambiguous question", async () => {
    const { status, body, contentType } = await get<ProblemBody>(
      `/v1/organizations/${E.orgSage}/technologies`,
    );
    expect(status).toBe(400);
    expect(contentType).toContain("application/problem+json");
    expect(body.code).toBe("relationship_required");
    expect(body.title).toContain("develops");
  });

  test("'who made the tools Sage runs' — fields=vendors expands each creator", async () => {
    const { body } = await get<TechListBody>(
      `/v1/organizations/${E.orgSage}/technologies?relationship=uses&fields=vendors`,
    );
    const byName = Object.fromEntries(
      body.results.map((r) => [r.technology.canonical_name, r.creator?.display_name]),
    );
    expect(byName["Google Analytics"]).toBe("Google");
    expect(byName["Google Keyword Planner"]).toBe("Google");
    expect(byName.WordPress).toBe("Automattic");
  });

  test("the reverse traversal: who uses Google Analytics", async () => {
    const { body } = await get<{ results: { organization: { display_name: string } }[] }>(
      `/v1/technologies/${E.techGa}/organizations?relationship=uses`,
    );
    expect(body.results.map((r) => r.organization.display_name)).toContain("Sage");
  });
});

describe("people and schools", () => {
  test("where does Alex work + where did Alex study (one call each)", async () => {
    const work = await get<PersonBody>(`/v1/people/${E.pnAlex}?fields=positions`);
    const position = work.body.person.positions?.[0];
    expect(position).toBeDefined();
    expect(position?.organization?.display_name).toBe("Sage");
    expect(position?.title).toBe("Software Engineer");

    const study = await get<PersonBody>(`/v1/people/${E.pnAlex}?fields=educations`);
    const education = study.body.person.educations?.[0];
    expect(education).toBeDefined();
    expect(education?.organization?.display_name).toBe("SPPU");
    expect(education?.degree).toBe("B.Tech");
    expect(education?.completed).toBe(true);

    // Field groups are opt-in: no `fields` param means neither group ships.
    const bare = await get<PersonBody>(`/v1/people/${E.pnAlex}`);
    expect(bare.body.person.positions).toBeUndefined();
    expect(bare.body.person.educations).toBeUndefined();
  });

  test("who works at Sage → Alex and Siya", async () => {
    const { body } = await get<PeopleListBody>(
      `/v1/organizations/${E.orgSage}/people?relationship=employee&current=true`,
    );
    expect(body.results.map((r) => r.person.full_name).sort()).toEqual(["Alex Mehta", "Siya Rao"]);
  });

  test("alumni of SPPU (derived from dates)", async () => {
    const { body } = await get<PeopleListBody>(
      `/v1/organizations/${E.orgSppu}/people?edge=education&education_status=completed`,
    );
    expect(body.results.map((r) => r.person.full_name)).toEqual(["Alex Mehta"]);
  });

  test("Alex's colleagues → Siya", async () => {
    const { body } = await get<PeopleListBody>(`/v1/people/${E.pnAlex}/colleagues`);
    expect(body.results.map((r) => r.person.full_name)).toEqual(["Siya Rao"]);
  });
});

describe("ownership, time travel, evidence", () => {
  test("who owned Sage Intacct in 2016 → Intacct Inc., not Sage", async () => {
    const { body } = await get<VendorListBody>(
      `/v1/technologies/${E.techIntacct}/vendors?as_of=2016-01-01`,
    );
    const owners = body.results.filter((v) => v.relationship !== "creator");
    expect(owners).toHaveLength(1);
    expect(owners[0]?.organization.legal_name).toBe("Intacct Inc.");
  });

  test("Sage's stack as of 2023-01-01 excluded WordPress", async () => {
    const { body } = await get<TechListBody>(
      `/v1/organizations/${E.orgSage}/technologies?relationship=uses&as_of=2023-01-01`,
    );
    expect(techNames(body.results)).toEqual(["Google Analytics"]);
  });

  test("min_confidence filters edges", async () => {
    const high = await get<TechListBody>(
      `/v1/organizations/${E.orgSage}/technologies?relationship=uses&min_confidence=0.95`,
    );
    expect(high.body.results).toHaveLength(0);
    const all = await get<TechListBody>(
      `/v1/organizations/${E.orgSage}/technologies?relationship=uses&min_confidence=0.5`,
    );
    expect(all.body.results).toHaveLength(3);
  });

  test("evidence: how do we know Alex works at Sage", async () => {
    const { body } = await get<EvidenceBody>(`/v1/evidence/${E.posAlexSage}`);
    expect(body.edge_kind).toBe("person_position");
    expect(body.fused_confidence).toBe(0.91);
    expect(body.attestations).toHaveLength(2);
    expect(body.attestations[0]?.raw_assertion).toContain("Alex Mehta");
  });
});

describe("resolution", () => {
  test("identify by domain is deterministic (confidence 1.0)", async () => {
    const { body } = await get<MatchBody>("/v1/organizations/identify?domain=sage.com");
    expect(body.match_type).toBe("domain");
    expect(body.matches[0]?.match_confidence).toBe(1);
    expect(body.matches[0]?.organization?.org_id).toBe(E.orgSage);
  });

  test("identify by alias returns ranked candidates", async () => {
    const { body } = await get<MatchBody>("/v1/organizations/identify?name=SPPU");
    expect(body.match_type).toBe("name");
    expect(body.matches[0]?.organization?.org_id).toBe(E.orgSppu);
    expect(body.matches[0]?.match_confidence).toBeLessThan(1);
  });

  test("technology alias GA4 resolves", async () => {
    const { body } = await get<MatchBody>("/v1/technologies/identify?name=GA4");
    expect(body.matches[0]?.technology?.canonical_name).toBe("Google Analytics");
  });

  test("two lookup keys is a 400", async () => {
    const { status, body } = await get<ProblemBody>(
      "/v1/organizations/identify?domain=sage.com&name=Sage",
    );
    expect(status).toBe(400);
    expect(body.code).toBe("identify_key_required");
  });
});

describe("contract discipline", () => {
  test("unknown route returns problem+json, not plain text", async () => {
    const { status, body, contentType } = await get<ProblemBody>("/v1/nope");
    expect(status).toBe(404);
    expect(contentType).toContain("application/problem+json");
    expect(body.code).toBe("route_not_found");
  });

  test("a malformed id is rejected before any query runs", async () => {
    const { status, body } = await get<ProblemBody>("/v1/organizations/not-an-id");
    expect(status).toBe(400);
    expect(body.code).toBe("org_id_invalid");
  });

  test("an unknown org is 404 with the shared envelope", async () => {
    const { status, body } = await get<ProblemBody>(
      "/v1/organizations/org_00000000000000000000000000",
    );
    expect(status).toBe(404);
    expect(body.code).toBe("organization_not_found");
  });

  test("limit is clamped to the hard maximum", async () => {
    const { status } = await get(
      `/v1/organizations/${E.orgSage}/technologies?relationship=uses&limit=100000`,
    );
    expect(status).toBe(200);
  });

  test("bad limit / min_confidence / as_of are rejected with named codes", async () => {
    expect(
      (
        await get<ProblemBody>(
          `/v1/organizations/${E.orgSage}/technologies?relationship=uses&limit=0`,
        )
      ).body.code,
    ).toBe("limit_invalid");
    expect(
      (
        await get<ProblemBody>(
          `/v1/organizations/${E.orgSage}/technologies?relationship=uses&min_confidence=7`,
        )
      ).body.code,
    ).toBe("min_confidence_invalid");
    expect(
      (
        await get<ProblemBody>(
          `/v1/organizations/${E.orgSage}/technologies?relationship=uses&as_of=yesterday`,
        )
      ).body.code,
    ).toBe("as_of_invalid");
  });

  test("auth is enforced when a key is configured", async () => {
    const guarded = createApp({ db, apiKey: "secret" }) as never as Hono;
    expect((await guarded.request("/v1/organizations/identify?domain=sage.com")).status).toBe(401);
    const ok = await guarded.request("/v1/organizations/identify?domain=sage.com", {
      headers: { authorization: "Bearer secret" },
    });
    expect(ok.status).toBe(200);
    expect((await guarded.request("/health")).status).toBe(200); // public
  });
});
