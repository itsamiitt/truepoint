// nlSearchAdapter.test.ts — CONTRACT tests for the Anthropic NL→search adapter on RECORDED Messages-API
// responses (14 §3.5: no live spend, no API key in CI). Proves: a well-formed model JSON is parsed +
// VALIDATED into a contactQuery; an out-of-schema model output is repaired on a single retry; a persistently
// invalid output throws AiParseError("ai_invalid_output"); a missing API key fails closed without a network
// call; auth/HTTP errors surface as AiParseError("ai_unavailable"). The adapter never returns raw SQL or an
// unvalidated shape (23, ADR-0023).

import { describe, expect, test } from "bun:test";
import { AiParseError, buildSearchSchemaContext } from "@leadwolf/core";
import { type FetchJson, anthropicNlSearchAdapter } from "./nlSearchAdapter.ts";

const SCHEMA = buildSearchSchemaContext();

/** A recorded Messages-API response carrying the model's JSON in a text content block. */
const messagesResponse = (obj: unknown) => ({
  status: 200,
  json: { content: [{ type: "text", text: JSON.stringify(obj) }] },
});

const VALID_QUERY = {
  text: "fintech",
  filters: [{ kind: "term", field: "title", op: "include", values: ["VP of Engineering"] }],
  sort: "relevance",
  notes: "VPs of Engineering at fintechs",
};

// An out-of-schema object the model might emit (bogus facet + op) — must fail validation.
const INVALID_QUERY = {
  filters: [{ kind: "term", field: "not_a_facet", op: "delete", values: ["x"] }],
};

function fixture(...responses: ReturnType<typeof messagesResponse>[]): {
  fetchJson: FetchJson;
  calls: number;
} {
  const box = {
    calls: 0,
    fetchJson: (async () => {
      const r = responses[Math.min(box.calls, responses.length - 1)];
      box.calls += 1;
      return r;
    }) as FetchJson,
  };
  return box;
}

describe("anthropicNlSearchAdapter", () => {
  test("parses + validates a well-formed model output into a contactQuery", async () => {
    const fx = fixture(messagesResponse(VALID_QUERY));
    const adapter = anthropicNlSearchAdapter({ apiKey: "test-key", fetchJson: fx.fetchJson });
    const out = await adapter.parseSearchQuery("VPs of Eng at fintechs", SCHEMA);

    expect(out.usedRepair).toBe(false);
    expect(out.notes).toBe("VPs of Engineering at fintechs");
    expect(out.query.filters).toHaveLength(1);
    const clause = out.query.filters[0];
    expect(clause?.kind).toBe("term");
    if (clause?.kind === "term") expect(clause.field).toBe("title");
    expect(fx.calls).toBe(1); // no repair needed
  });

  test("extracts JSON from a later text block when a leading block is a non-JSON preamble", async () => {
    const fx = fixture({
      status: 200,
      json: {
        content: [
          { type: "text", text: "Here is the filter:" }, // non-JSON preamble must not abort extraction
          { type: "text", text: JSON.stringify(VALID_QUERY) },
        ],
      },
    });
    const adapter = anthropicNlSearchAdapter({ apiKey: "test-key", fetchJson: fx.fetchJson });
    const out = await adapter.parseSearchQuery("VPs of Eng", SCHEMA);
    expect(out.usedRepair).toBe(false);
    expect(out.query.filters[0]?.kind).toBe("term");
    expect(fx.calls).toBe(1); // no wasted repair
  });

  test("repairs on a single retry when the first output is out-of-schema", async () => {
    const fx = fixture(messagesResponse(INVALID_QUERY), messagesResponse(VALID_QUERY));
    const adapter = anthropicNlSearchAdapter({ apiKey: "test-key", fetchJson: fx.fetchJson });
    const out = await adapter.parseSearchQuery("VPs of Eng", SCHEMA);

    expect(out.usedRepair).toBe(true);
    expect(out.query.filters[0]?.kind).toBe("term");
    expect(fx.calls).toBe(2); // first + one repair
  });

  test("throws ai_invalid_output when the output stays invalid after repair", async () => {
    const fx = fixture(messagesResponse(INVALID_QUERY), messagesResponse(INVALID_QUERY));
    const adapter = anthropicNlSearchAdapter({ apiKey: "test-key", fetchJson: fx.fetchJson });
    await expect(adapter.parseSearchQuery("nonsense", SCHEMA)).rejects.toMatchObject({
      name: "AiParseError",
      reason: "ai_invalid_output",
    });
  });

  test("fails closed with NO network call when the API key is absent", async () => {
    let called = false;
    const fetchJson: FetchJson = async () => {
      called = true;
      return { status: 200, json: null };
    };
    const adapter = anthropicNlSearchAdapter({ apiKey: undefined, fetchJson });
    await expect(adapter.parseSearchQuery("VPs of Eng", SCHEMA)).rejects.toMatchObject({
      name: "AiParseError",
      reason: "ai_unavailable",
    });
    expect(called).toBe(false);
  });

  test("maps an auth/HTTP error to ai_unavailable (never leaks the provider error)", async () => {
    const fetchJson: FetchJson = async () => ({ status: 401, json: { error: "nope" } });
    const adapter = anthropicNlSearchAdapter({ apiKey: "bad", fetchJson });
    await expect(adapter.parseSearchQuery("VPs of Eng", SCHEMA)).rejects.toBeInstanceOf(
      AiParseError,
    );
  });

  test("sends structured-output config + the model, and never raw SQL", async () => {
    const sent: Record<string, unknown>[] = [];
    const fetchJson: FetchJson = async (_url, init) => {
      sent.push(init.body as Record<string, unknown>);
      return messagesResponse(VALID_QUERY);
    };
    const adapter = anthropicNlSearchAdapter({
      apiKey: "k",
      model: "claude-opus-4-8",
      fetchJson,
    });
    await adapter.parseSearchQuery("VPs of Eng", SCHEMA);
    const body = sent[0];
    expect(body).toBeDefined();
    expect(body?.model).toBe("claude-opus-4-8");
    expect(body).toHaveProperty("output_config");
  });
});
