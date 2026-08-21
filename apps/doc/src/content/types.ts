// types.ts — the shapes every page on doc.truepoint.in renders from (ADR-0048 §D3).
//
// Content on this site is typed data, not MDX and not hand-written HTML. Three things follow from that, all
// of them deliberate: the API reference cannot structurally drift between endpoints (a missing error table is
// a type error, not a page someone forgets to finish), `bun run typecheck` becomes a content gate, and no
// page anywhere needs dangerouslySetInnerHTML.

/** Whether the thing being described is actually callable today. Rendered as a badge on every surface that
 *  names an endpoint, dataset or plan. The honest default is "planned": publishing a price and a contract
 *  before the code exists is the plan's own positioning move, but a reader must never have to guess which
 *  half they are looking at. */
export type Availability = "available" | "beta" | "planned";

export interface Param {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}

export interface FieldSpec {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  /** Set where a field carries provenance/confidence rather than a plain value (S-10, A-01). */
  readonly provenance?: boolean;
}

export interface ErrorSpec {
  readonly status: number;
  /** The RFC 9457 `type` slug the platform's problem+json responses carry. */
  readonly code: string;
  readonly meaning: string;
}

export interface Endpoint {
  readonly slug: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly title: string;
  readonly summary: string;
  readonly availability: Availability;
  /** Credits charged on a successful match. Zero means free — see creditActions.ts for why that matters. */
  readonly credits: number;
  /** One line stating exactly what is and is not billable for this call. */
  readonly billing: string;
  readonly params: readonly Param[];
  readonly returns: readonly FieldSpec[];
  readonly errors: readonly ErrorSpec[];
  readonly example: { readonly request: string; readonly response: string };
}

export interface CreditAction {
  readonly action: string;
  readonly credits: number | "free";
  readonly note: string;
}

export interface Plan {
  readonly slug: string;
  readonly name: string;
  readonly price: string;
  readonly cadence: string;
  readonly credits: string;
  readonly audience: string;
  readonly includes: readonly string[];
  readonly availability: Availability;
}

export interface Dataset {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly coverage: string;
  readonly refresh: string;
  readonly availability: Availability;
  readonly fields: readonly FieldSpec[];
  /** Illustrative rows only. Never real people — see ADR-0048 §D5 and sampleNotice below. */
  readonly sampleRows: readonly Record<string, string>[];
}

/** A prose page under /docs, expressed as blocks so it renders without an HTML parser. */
export type Block =
  | { readonly kind: "p"; readonly text: string }
  | { readonly kind: "h2"; readonly text: string }
  | { readonly kind: "list"; readonly items: readonly string[] }
  | { readonly kind: "code"; readonly language: string; readonly source: string }
  | { readonly kind: "note"; readonly tone: "info" | "warning"; readonly text: string }
  | {
      readonly kind: "table";
      readonly headers: readonly string[];
      readonly rows: readonly (readonly string[])[];
    };

export interface Guide {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly blocks: readonly Block[];
}

/** A section of the trust statement. Carries its own `id` because these sections are linked to directly —
 *  from the footer, and by anyone who needs to point a colleague at "the bit about what you never collect". */
export interface TrustSection {
  readonly id: string;
  readonly title: string;
  readonly blocks: readonly Block[];
}

export interface ChangelogEntry {
  /** ISO date. Sorted newest-first at render time, so entry order in the file does not matter. */
  readonly date: string;
  readonly title: string;
  readonly body: string;
}
