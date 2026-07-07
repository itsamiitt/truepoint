import { describe, expect, test } from "bun:test";
import {
  type ParseStageDeps,
  ParserRegistry,
  VOYAGER_PROFILE_ENDPOINT,
  registerBuiltinParsers,
  runParse,
  shapeFingerprint,
  voyagerProfileParserV1,
} from "../src/index.ts";

const VOYAGER_FIXTURE = {
  firstName: "Jane",
  lastName: "Doe",
  headline: "VP Engineering at Acme",
  geoLocationName: "San Francisco Bay Area",
  publicIdentifier: "jane-doe",
};

function parserInput(payload: unknown, schemaVersion = "1-0-0") {
  return {
    rawPayload: payload,
    endpoint: VOYAGER_PROFILE_ENDPOINT,
    schemaVersion,
    ctx: { source: "chrome_extension", captureId: "c1", capturedAt: "2026-07-06T00:00:00.000Z" },
  };
}

describe("voyagerProfileParserV1 (golden characterization)", () => {
  test("parses the canonical profile deterministically (invariants 1 + 4)", () => {
    const a = voyagerProfileParserV1(parserInput(VOYAGER_FIXTURE));
    const b = voyagerProfileParserV1(parserInput(VOYAGER_FIXTURE));
    expect(a).toEqual(b); // pure + deterministic
    expect(a.status).toBe("parsed");

    const byPath = Object.fromEntries(a.fields.map((f) => [f.path, f.value]));
    expect(byPath.full_name).toBe("Jane Doe");
    expect(byPath.job_title).toBe("VP Engineering");
    expect(byPath.location).toBe("San Francisco Bay Area");
    expect(byPath.linkedin_public_id).toBe("jane-doe");

    const jt = a.fields.find((f) => f.path === "job_title");
    expect(jt?.sourcePath).toBe("headline");
    expect(jt?.transformation).toBe("normalize");
  });

  test("no clear PII in fields; email → blind index only (invariant 3)", () => {
    const r = voyagerProfileParserV1(
      parserInput({ ...VOYAGER_FIXTURE, emailAddress: "Jane.Doe@Acme.com" }),
    );
    expect(JSON.stringify(r.fields)).not.toContain("Jane.Doe@Acme.com");
    expect(r.channels.emailBlindIndex).toMatch(/^[0-9a-f]{64}$/);
  });

  test("total: a bad shape quarantines and a missing name is partial — never throws (invariant 2)", () => {
    expect(voyagerProfileParserV1(parserInput("not-an-object")).status).toBe("quarantined");
    expect(voyagerProfileParserV1(parserInput({ headline: "x" })).status).toBe("partial");
  });
});

describe("ParserRegistry — selection + one-active lifecycle", () => {
  function reg() {
    const r = new ParserRegistry();
    registerBuiltinParsers(r);
    return r;
  }

  test("selects the active version for a known schema_version", () => {
    expect(reg().select("chrome_extension", VOYAGER_PROFILE_ENDPOINT, "1-0-0", "").kind).toBe(
      "parse",
    );
  });

  test("NO_PARSER for an unknown endpoint", () => {
    expect(reg().select("chrome_extension", "voyager/unknown", "1-0-0", "")).toMatchObject({
      kind: "quarantine",
      route: "NO_PARSER",
    });
  });

  test("SHAPE_DRIFT for an unknown schema_version + mismatched fingerprint", () => {
    expect(
      reg().select("chrome_extension", VOYAGER_PROFILE_ENDPOINT, "9-9-9", "totally,different"),
    ).toMatchObject({ kind: "quarantine", route: "SHAPE_DRIFT" });
  });

  test("admits an unknown schema_version when the fingerprint matches (BACKWARD tolerance)", () => {
    const fp = shapeFingerprint(VOYAGER_FIXTURE);
    expect(reg().select("chrome_extension", VOYAGER_PROFILE_ENDPOINT, "9-9-9", fp).kind).toBe(
      "parse",
    );
  });

  test("a second publish deprecates the prior — exactly one active (atomic cut-over)", () => {
    const r = reg();
    r.addVersion("chrome_extension", VOYAGER_PROFILE_ENDPOINT, {
      id: "v2",
      version: "1-1-0",
      parser: voyagerProfileParserV1,
      acceptedInputVersions: ["1-1-0"],
      shapeFingerprint: "x",
    });
    r.publish("chrome_extension", VOYAGER_PROFILE_ENDPOINT, "v2");
    expect(r.activeVersion("chrome_extension", VOYAGER_PROFILE_ENDPOINT)?.id).toBe("v2");
  });
});

describe("runParse (S1 stage)", () => {
  function deps() {
    const registry = new ParserRegistry();
    registerBuiltinParsers(registry);
    const written: unknown[] = [];
    const quarantined: unknown[] = [];
    const stage: ParseStageDeps = {
      registry,
      store: {
        upsert: async (row) => {
          written.push(row);
          return { written: true };
        },
      },
      blob: { fetch: async () => "" },
      quarantine: {
        record: async (id, route, reason) => {
          quarantined.push({ id, route, reason });
        },
      },
    };
    return { stage, written, quarantined };
  }

  const capture = (over: Record<string, unknown> = {}) => ({
    id: "c1",
    source: "chrome_extension",
    endpoint: VOYAGER_PROFILE_ENDPOINT,
    schemaVersion: "1-0-0",
    fingerprint: "",
    payloadInline: JSON.stringify(VOYAGER_FIXTURE),
    payloadRef: null,
    capturedAt: "2026-07-06T00:00:00.000Z",
    ...over,
  });

  test("parses a matched capture into a parsed_record", async () => {
    const d = deps();
    const out = await runParse(d.stage, capture());
    expect(out.outcome).toBe("parsed");
    expect(d.written).toHaveLength(1);
    expect(d.quarantined).toHaveLength(0);
  });

  test("routes an unmatched endpoint to the quarantine lane (never into silver)", async () => {
    const d = deps();
    const out = await runParse(d.stage, capture({ endpoint: "voyager/unknown" }));
    expect(out.outcome).toBe("NO_PARSER");
    expect(d.written).toHaveLength(0);
    expect(d.quarantined).toHaveLength(1);
  });
});
