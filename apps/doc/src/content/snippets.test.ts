// snippets.test.ts — the derived-language examples, checked against the contract they came from.
//
// The derivation is only safe if two things hold, and neither is obvious by reading a page: the cURL example
// still parses into the request the endpoint actually declares, and the languages agree with it. A snippet
// that quietly loses a header or a body field is worse than no snippet — a reader trusts it more than prose.

import { describe, expect, test } from "bun:test";
import { ENDPOINTS } from "./endpoints/index.ts";
import { buildSnippets, parseCurl } from "./snippets.ts";

describe("every endpoint's cURL example parses into its declared contract", () => {
  for (const endpoint of ENDPOINTS) {
    test(`${endpoint.slug}: method, URL and body agree with the spec`, () => {
      const parsed = parseCurl(endpoint.example.request);
      expect(parsed.method).toBe(endpoint.method);
      expect(parsed.url).toBe(`https://api.truepoint.in${endpoint.path}`);
      expect(parsed.headers.some(([name]) => name.toLowerCase() === "authorization")).toBe(true);

      if (endpoint.method === "POST") {
        expect(parsed.body).not.toBeNull();
        expect(() => JSON.parse(parsed.body as string)).not.toThrow();
      } else {
        expect(parsed.query.length).toBeGreaterThan(0);
      }
    });

    test(`${endpoint.slug}: every required parameter appears in the example`, () => {
      const parsed = parseCurl(endpoint.example.request);
      const carried = new Set<string>([
        ...parsed.query.map(([name]) => name),
        ...(parsed.body ? Object.keys(JSON.parse(parsed.body) as Record<string, unknown>) : []),
      ]);
      for (const param of endpoint.params) {
        if (param.required) expect(carried.has(param.name)).toBe(true);
      }
    });
  }
});

describe("the derived languages say the same thing", () => {
  for (const endpoint of ENDPOINTS) {
    const snippets = buildSnippets(endpoint);
    const byId = Object.fromEntries(snippets.map((snippet) => [snippet.id, snippet.source]));

    test(`${endpoint.slug}: three languages, cURL unchanged from the reviewed example`, () => {
      expect(snippets.map((snippet) => snippet.id)).toEqual(["curl", "node", "python"]);
      expect(byId.curl).toBe(endpoint.example.request);
    });

    test(`${endpoint.slug}: every language targets the same URL`, () => {
      for (const source of Object.values(byId)) {
        expect(source).toContain(endpoint.path);
      }
    });

    test(`${endpoint.slug}: no language hardcodes a key`, () => {
      expect(byId.node).toContain("process.env.TRUEPOINT_API_KEY");
      expect(byId.python).toContain('os.environ["TRUEPOINT_API_KEY"]');
      for (const source of Object.values(byId)) {
        expect(source).not.toMatch(/tp_live_[A-Za-z0-9]/);
      }
    });

    test(`${endpoint.slug}: every language handles the error contract`, () => {
      for (const [id, source] of Object.entries(byId)) {
        if (id === "curl") continue;
        expect(source).toContain("problem");
        expect(source).toContain("code");
      }
    });

    if (endpoint.method === "POST") {
      test(`${endpoint.slug}: the body survives into both languages`, () => {
        const parsed = parseCurl(endpoint.example.request);
        const body = JSON.parse(parsed.body as string) as Record<string, unknown>;
        for (const key of Object.keys(body)) {
          expect(byId.node).toContain(key);
          expect(byId.python).toContain(key);
        }
      });

      test(`${endpoint.slug}: Python spells JSON literals the Python way`, () => {
        // json.dumps-shaped output would be accepted by requests, but a reader copying it into a REPL gets a
        // NameError on `true`. The transform exists for exactly this.
        expect(byId.python).not.toMatch(/\b(true|false|null)\b/);
      });
    }

    if (endpoint.credits > 0) {
      test(`${endpoint.slug}: the Idempotency-Key header is not dropped in derivation`, () => {
        if (!endpoint.example.request.includes("Idempotency-Key")) return;
        expect(byId.node).toContain("Idempotency-Key");
        expect(byId.python).toContain("Idempotency-Key");
      });
    }
  }
});

describe("the parser fails loudly rather than silently", () => {
  test("a GET with no recognisable URL yields an empty one rather than a wrong one", () => {
    const parsed = parseCurl('curl -H "Authorization: Bearer $KEY"');
    expect(parsed.url).toBe("");
  });

  test("query parameters are read from both --data-urlencode and an inline query string", () => {
    expect(
      parseCurl('curl -G https://x.test/y --data-urlencode "domain=a.example.com"').query,
    ).toEqual([["domain", "a.example.com"]]);
    expect(parseCurl("curl https://x.test/y?domain=a.example.com").query).toEqual([
      ["domain", "a.example.com"],
    ]);
  });
});
