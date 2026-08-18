// guards.ts — plausibility guards for DOM-extracted person fields (Layer-0-as-database plan, slice 5b).
// The extractor reads whatever the first matching selector says; without a guard a page-chrome heading
// ("Sales Navigator Lead Page") or an a11y label becomes a "name" and lands as a junk contact. Pure —
// no DOM types — so it is unit-testable and reusable by every adapter.
import { text } from "./dom.ts";

const CHROME_TEXT =
  /sales navigator|linkedin|search results|lead page|premium|notifications?|messaging/i;
const MAX_NAME_WORDS = 6;
const MAX_NAME_CHARS = 80;

/** Does this text plausibly name a person (not page chrome, not a sentence, not a UI label)? */
export function isPlausiblePersonName(s: string | undefined | null): s is string {
  if (!s) return false;
  const v = s.trim();
  if (v.length < 2 || v.length > MAX_NAME_CHARS) return false;
  if (CHROME_TEXT.test(v)) return false;
  if (/[|\n\r\t]/.test(v)) return false;
  if (v.split(/\s+/).length > MAX_NAME_WORDS) return false;
  // A name has letters; a pure number/punctuation string is not one.
  if (!/\p{L}/u.test(v)) return false;
  return true;
}

/** Any non-empty short line — headline/title/location. Rejects paragraphs and page chrome. */
export function isPlausibleShortField(s: string | undefined | null, max = 160): s is string {
  if (!s) return false;
  const v = s.trim();
  if (v.length < 1 || v.length > max) return false;
  if (/[\n\r]/.test(v)) return false;
  return !CHROME_TEXT.test(v) || /\bat\b/i.test(v); // "Engineer at LinkedIn" is a real headline
}

/** First candidate whose text passes `guard`, in selector order. Never falls through to an unscoped
 *  document-wide `h1` — the caller supplies the scoped root. */
export function firstPlausible(
  root: ParentNode,
  selectors: readonly string[],
  guard: (s: string | undefined) => boolean,
): string | undefined {
  for (const selector of selectors) {
    const found = text(root.querySelector(selector));
    if (guard(found)) return found;
  }
  return undefined;
}
