// replyClassifierAdapter.test.ts — fixture tests for the Anthropic reply classifier (Part C). No live spend, no
// key: fetchJson is injected. Run with a dummy env (the adapter imports @leadwolf/config at module load).

import { describe, expect, test } from "bun:test";
import { anthropicReplyClassifierAdapter } from "./replyClassifierAdapter.ts";

const okResponse = (label: string) => ({
  status: 200,
  json: {
    content: [{ type: "text", text: JSON.stringify({ classification: label }) }],
    usage: { input_tokens: 40, output_tokens: 3 },
  },
});

describe("anthropicReplyClassifierAdapter", () => {
  test("fails closed when no API key is configured", async () => {
    const a = anthropicReplyClassifierAdapter({
      apiKey: "",
      fetchJson: async () => ({ status: 200, json: {} }),
    });
    await expect(a.classify("hi")).rejects.toThrow(/not configured/);
  });

  test("returns the classification + token usage", async () => {
    const a = anthropicReplyClassifierAdapter({
      apiKey: "k",
      model: "claude-x",
      fetchJson: async () => okResponse("human"),
    });
    const r = await a.classify("Yes, let's talk next week.");
    expect(r).toEqual({
      classification: "human",
      model: "claude-x",
      usage: { inputTokens: 40, outputTokens: 3 },
    });
  });

  test("maps a 401 to a fail-open error", async () => {
    const a = anthropicReplyClassifierAdapter({
      apiKey: "k",
      fetchJson: async () => ({ status: 401, json: null }),
    });
    await expect(a.classify("hi")).rejects.toThrow(/authentication/);
  });

  test("rejects an invalid/unparseable label", async () => {
    const a = anthropicReplyClassifierAdapter({
      apiKey: "k",
      fetchJson: async () => ({
        status: 200,
        json: { content: [{ type: "text", text: "not json" }] },
      }),
    });
    await expect(a.classify("hi")).rejects.toThrow(/No valid classification/);
  });
});
