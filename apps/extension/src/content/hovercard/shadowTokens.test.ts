// shadowTokens.test.ts — the hover card injects the DS token stylesheet into its Shadow DOM. This asserts
// the one transform that makes that work, because the failure it guards was completely invisible.
//
// `:root` matches the document ELEMENT. A ShadowRoot is a DocumentFragment, so it never matches — the whole
// tokens.css shipped into every LinkedIn page and did nothing. Every `var(--tp-*)` in the card silently fell
// through to its inline fallback (wrong shadow, wrong font), and `:focus-visible { outline: 2px solid
// var(--focus-ring) }` — a PLAIN selector, so it *did* apply in there — became invalid at computed-value time
// with `--focus-ring` undefined. An invalid `outline` unsets to `outline-style: none`, so the rule meant to
// guarantee a focus ring destroyed the UA's default one on the card's primary action.
//
// Nothing could see any of that: it type-checks, it lints, the card renders, and the only symptom is that a
// keyboard user on a customer's LinkedIn page has no visible focus. Hence a test on the transform itself.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scopeTokensToShadowHost } from "./index.ts";

const TOKENS_CSS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../packages/ui/src/tokens.css",
);

describe("scopeTokensToShadowHost", () => {
  test("rewrites the :root block so the tokens land on the shadow host", () => {
    expect(scopeTokensToShadowHost(":root { --tp-ink: #111827; }")).toBe(
      ":host { --tp-ink: #111827; }",
    );
  });

  test("leaves other selectors — including :focus-visible — alone", () => {
    const css = ":focus-visible { outline: 2px solid var(--focus-ring); }";
    expect(scopeTokensToShadowHost(css)).toBe(css);
  });

  test("does not maul a selector that merely starts with :root", () => {
    // The lookahead matters: `\b` sits between "t" and "-", so the first version of this transform DID
    // rewrite `:root-panel` to `:host-panel`. This test is what found it.
    expect(scopeTokensToShadowHost(":root-panel { color: red; }")).toBe(
      ":root-panel { color: red; }",
    );
  });

  test("the real tokens.css ends up with no :root left and the tokens on :host", () => {
    // The end-to-end property, read from the actual stylesheet the content script imports. If tokens.css
    // ever grows a second :root block, or the transform stops matching, this fails here rather than shipping
    // a silently unstyled card to a customer's LinkedIn page.
    const scoped = scopeTokensToShadowHost(readFileSync(TOKENS_CSS, "utf8"));
    expect(scoped).not.toContain(":root");
    expect(scoped).toContain(":host");
    // The two tokens whose absence caused the visible symptoms.
    expect(scoped).toMatch(/:host[\s\S]*--focus-ring:/);
    expect(scoped).toMatch(/:host[\s\S]*--tp-shadow-popover:/);
  });
});
