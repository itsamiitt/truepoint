// shadowTokens.ts — the DS token stylesheet, re-scoped so it works inside the card's Shadow DOM.
import tokens from "@leadwolf/ui/tokens.css?inline";

/**
 * The DS tokens are declared on `:root` — and `:root` matches the document ELEMENT, which a ShadowRoot is
 * not (it is a DocumentFragment). So importing tokens.css into the shadow tree shipped the whole stylesheet
 * into every LinkedIn page for ZERO effect: every var() below silently fell through to its inline fallback,
 * the card rendered in the host page's font with a heavier, colder shadow than any other TruePoint popover,
 * and — worst — tokens.css's `:focus-visible { outline: 2px solid var(--focus-ring) }` DID match in here
 * (a plain selector, unlike :root) with `--focus-ring` undefined, making the declaration invalid at
 * computed-value time. An invalid `outline` unsets to `outline-style: none`, so the rule intended to
 * GUARANTEE a focus ring destroyed the UA's default one on the card's primary action.
 *
 * Re-scoping the selector to `:host` puts the same tokens on the shadow host, where the card can see them.
 */
export function scopeTokensToShadowHost(css: string): string {
  // `(?![\w-])`, not `\b`: a word boundary sits between "t" and "-", so `\b` would rewrite a selector like
  // `:root-panel` into `:host-panel`. Caught by its own test rather than by a mangled page.
  return css.replace(/:root(?![\w-])/g, ":host");
}

export const shadowTokens = scopeTokensToShadowHost(tokens);
