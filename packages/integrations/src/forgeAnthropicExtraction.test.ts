// forgeAnthropicExtraction.test.ts — pins the MODEL ↔ THINKING-PARAMETER contract.
//
// Why this test exists: the thinking parameter is model-dependent, and a mismatch is rejected with a 400 that
// this adapter deliberately swallows as `ai_unavailable` (fail-closed, never throw into the DAG). That makes a
// mismatch *silent* — the extract stage goes offline and reports "provider unavailable". Exactly that shipped:
// `{type:"adaptive"}` was sent to claude-haiku-4-5, which does not support adaptive thinking, so every
// extraction 400'd. A unit test on the request BODY is the only cheap way to catch it, because no live call is
// made in CI and the failure mode produces no error anywhere.

import { describe, expect, it } from "bun:test";
import { anthropicExtractionPort, thinkingParamFor } from "./forgeAnthropicExtraction.ts";

describe("thinkingParamFor", () => {
  it("uses adaptive thinking on the 4.6-generation and later models", () => {
    for (const model of [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-fable-5",
    ]) {
      expect(thinkingParamFor(model, 4096)).toEqual({ type: "adaptive" });
    }
  });

  it("uses manual extended thinking with a budget on pre-4.6 models", () => {
    // The Forge default model is a dated Haiku 4.5 alias — the prefix match must still catch it.
    const param = thinkingParamFor("claude-haiku-4-5-20251001", 4096);
    expect(param).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("keeps budget_tokens at or above the 1024 API floor and strictly below max_tokens", () => {
    const param = thinkingParamFor("claude-haiku-4-5", 2048);
    expect(param).toMatchObject({ type: "enabled" });
    if (param.type !== "enabled") throw new Error("expected budgeted thinking");
    expect(param.budget_tokens).toBeGreaterThanOrEqual(1024);
    expect(param.budget_tokens).toBeLessThan(2048);
  });

  it("throws when max_tokens cannot accommodate the thinking floor", () => {
    // The old default (1024) could not satisfy budget_tokens >= 1024 AND budget_tokens < max_tokens.
    expect(() => thinkingParamFor("claude-haiku-4-5", 1024)).toThrow(/max_tokens must exceed 1024/);
  });

  it("throws on an unknown model rather than guessing a thinking shape", () => {
    expect(() => thinkingParamFor("some-future-model", 4096)).toThrow(/unknown thinking support/);
  });
});

describe("anthropicExtractionPort request body", () => {
  /** Capture the outgoing request body without making a network call. */
  function capture(model: string, maxTokens?: number) {
    const sent: Record<string, unknown>[] = [];
    const port = anthropicExtractionPort({
      apiKey: "test-key",
      baseUrl: "https://api.test",
      version: "2023-06-01",
      model,
      maxTokens,
      fetchJson: async (_url, init) => {
        sent.push(JSON.parse(init.body) as Record<string, unknown>);
        return { status: 200, json: { content: [{ type: "text", text: '{"fields":[]}' }] } };
      },
    });
    return { port, sent };
  }

  it("sends budgeted thinking for the Haiku 4.5 default, with a budget under max_tokens", async () => {
    const { port, sent } = capture("claude-haiku-4-5-20251001");
    await port.extract({
      residue: "Acme Corp, London",
      targetFields: ["company"],
      schemaVersion: "1",
    });
    expect(sent).toHaveLength(1);
    const body = sent[0];
    expect(body?.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(body?.max_tokens).toBe(4096);
    // Never send `effort` to a pre-4.6 model — it is rejected.
    expect(body?.output_config).not.toHaveProperty("effort");
  });

  it("sends adaptive thinking when configured with a 4.6+ model", async () => {
    const { port, sent } = capture("claude-sonnet-5");
    await port.extract({ residue: "Acme Corp", targetFields: ["company"], schemaVersion: "1" });
    expect(sent[0]?.thinking).toEqual({ type: "adaptive" });
  });

  it("throws at construction on a model/params mismatch instead of per request", () => {
    expect(() =>
      anthropicExtractionPort({
        apiKey: "test-key",
        baseUrl: "https://api.test",
        version: "2023-06-01",
        model: "claude-haiku-4-5",
        maxTokens: 512, // below the thinking floor
        fetchJson: async () => ({ status: 200, json: {} }),
      }),
    ).toThrow(/max_tokens must exceed 1024/);
  });
});
