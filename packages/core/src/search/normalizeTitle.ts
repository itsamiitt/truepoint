// normalizeTitle.ts — turn a raw, free-text job title into a stable comparison key (24 §4.1). The SAME
// function normalizes both the user's typed term and the taxonomy aliases, so they compare apples-to-apples
// ("C.E.O." and "ceo" and "Chief Executive Officer" all collapse correctly). Pure string logic, no I/O.

/** Token-level expansions of common contractions/abbreviations applied during normalization. */
const TOKEN_EXPANSIONS: Record<string, string> = {
  sr: "senior",
  snr: "senior",
  jr: "junior",
  mgr: "manager",
  mgmt: "management",
  asst: "assistant",
  assoc: "associate",
  dir: "director",
  ops: "operations",
  exec: "executive",
  eng: "engineering",
  dev: "developer",
};

/**
 * Lowercase, strip punctuation, expand common contractions, and collapse whitespace.
 * Returns "" for input that has no usable characters.
 */
export function normalizeTitle(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ") // drop dots, slashes, dashes, commas → spaces
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .map((token) => TOKEN_EXPANSIONS[token] ?? token)
    .join(" ");
}
