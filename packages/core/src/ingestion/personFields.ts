// personFields.ts — PURE person-field normalizers shared by every overlay landing path (capture,
// database materialization). No IO, no DB: same input → same output, so both callers derive identical
// scalars from differently-shaped sources.

/** Trimmed non-empty string, else undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Split "City, Region, Country" best-effort; a single token stays city-only (never guess a country). */
export function splitLocation(location: string | undefined): { city?: string; country?: string } {
  if (!location) return {};
  const parts = location
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2) return { city: parts.slice(0, -1).join(", "), country: parts.at(-1) };
  return { city: parts[0] };
}

/** Prefer explicit first/last; else split a full name (last token = surname). */
export function names(input: {
  firstName?: string;
  lastName?: string;
  fullName?: string;
}): { firstName?: string; lastName?: string } {
  if (input.firstName || input.lastName) {
    return { firstName: input.firstName, lastName: input.lastName };
  }
  if (!input.fullName) return {};
  const parts = input.fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts.at(-1) };
}
