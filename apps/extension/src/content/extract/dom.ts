// DomExtractor helpers — read only VISIBLE, user-facing text from the rendered DOM (09 layer 1).
// No fetch/XHR patching, no MAIN-world injection, no private-API reads (the Apollo technique we reject).

export function text(el: Element | null | undefined): string | undefined {
  const value = el?.textContent?.trim();
  return value && value.length > 0 ? value : undefined;
}

/** First non-empty text among a list of candidate selectors (resilient to markup drift). */
export function firstText(root: ParentNode, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const found = text(root.querySelector(selector));
    if (found) {
      return found;
    }
  }
  return undefined;
}
