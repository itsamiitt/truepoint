// renderTemplate.test.ts — the render-safe template engine (M12 P2, 01). Pure, runs without infra. Proves:
// variables substitute, fallbacks fire on missing/empty, untrusted VALUES are HTML-escaped (injection
// boundary), substituted values are NOT re-rendered (no recursion), and the whitelist drops unknown keys.

import { describe, expect, test } from "bun:test";
import { extractVariables, renderTemplate } from "./renderTemplate.ts";

describe("renderTemplate", () => {
  test("substitutes known variables", () => {
    expect(
      renderTemplate("Hi {{first_name}} at {{company}}", { first_name: "Jane", company: "Acme" }),
    ).toBe("Hi Jane at Acme");
  });

  test("uses the fallback on a missing or empty value", () => {
    expect(renderTemplate("Hi {{first_name | there}}", {})).toBe("Hi there");
    expect(renderTemplate("Hi {{first_name | there}}", { first_name: "" })).toBe("Hi there");
    expect(renderTemplate("Hi {{first_name | there}}", { first_name: "Jane" })).toBe("Hi Jane");
  });

  test("HTML-escapes untrusted variable values (injection boundary)", () => {
    const out = renderTemplate("<p>{{name}}</p>", {
      name: "<script>alert(1)</script>",
    });
    expect(out).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(out).not.toContain("<script>");
  });

  test("preserves the template author's own markup, escapes only the value", () => {
    expect(renderTemplate('<a href="x">{{label}}</a>', { label: "Q1 & beyond" })).toBe(
      '<a href="x">Q1 &amp; beyond</a>',
    );
  });

  test("does NOT re-render a value that itself contains a token (no recursion)", () => {
    expect(renderTemplate("{{a}}", { a: "{{b}}", b: "PWNED" })).toBe("{{b}}");
  });

  test("a whitelist drops unknown keys to their fallback", () => {
    const allowedKeys = new Set(["first_name"]);
    expect(
      renderTemplate(
        "{{first_name}} / {{secret | hidden}}",
        { first_name: "Jane", secret: "S" },
        { allowedKeys },
      ),
    ).toBe("Jane / hidden");
  });

  test("escapeValues:false leaves a plain-text subject unescaped", () => {
    expect(renderTemplate("Re: {{topic}}", { topic: "A & B" }, { escapeValues: false })).toBe(
      "Re: A & B",
    );
  });

  test("extractVariables returns the distinct keys used", () => {
    expect(extractVariables("Hi {{first_name}}, {{first_name}} at {{company}}").sort()).toEqual([
      "company",
      "first_name",
    ]);
  });
});
