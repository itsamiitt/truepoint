// Prefixed ULID primary keys (00-overview §4.1): time-sortable, app-generated.
// Crockford base32, 48-bit timestamp + 80-bit randomness — no dependency needed.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms: number): string {
  let remaining = ms;
  let out = "";
  for (let i = 9; i >= 0; i--) {
    out = ALPHABET[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += ALPHABET[(bytes[i] as number) % 32];
  }
  return out;
}

export type IdPrefix =
  | "org"
  | "pn"
  | "tech"
  | "pos"
  | "edu"
  | "rel"
  | "tv"
  | "ce"
  | "att"
  | "src"
  | "oal"
  | "tal"
  | "cat";

export function newId(prefix: IdPrefix, at: Date = new Date()): string {
  return `${prefix}_${encodeTime(at.getTime())}${encodeRandom()}`;
}

/** Route an edge id to its table by prefix (the evidence endpoint's contract). */
export function edgeTableFor(edgeId: string): string | null {
  const prefix = edgeId.split("_")[0];
  switch (prefix) {
    case "pos":
      return "person_positions";
    case "edu":
      return "person_educations";
    case "rel":
      return "org_technology_relations";
    case "tv":
      return "technology_vendors";
    case "ce":
      return "company_edges";
    default:
      return null;
  }
}
