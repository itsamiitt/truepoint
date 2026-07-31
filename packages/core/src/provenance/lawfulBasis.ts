// lawfulBasis.ts — PURE resolution of the lawful basis a provenance event is recorded under (09-compliance
// rule 4: "Every ingestion path tags a lawful basis; anything untaggable doesn't enter the graph"; human
// decision D6, decisions.md 2026-07-31).
//
// This exists because provenance_event.lawful_basis is NOT NULL and, before it, nothing in the codebase
// derived one. source_records.lawful_basis_snapshot is written NULL by its only writer, and ingestion.ts's
// consentContext requires a basis for CAPTURE sources while marking it optional for admin_upload/enrichment/crm
// on the grounds that those "carry their basis elsewhere". This is that elsewhere.
//
// THE ORDER OF PRECEDENCE IS THE WHOLE DESIGN:
//   1. An explicit basis travelling WITH the data (consentContext on a capture) always wins. A user told us
//      what they consented to; nothing configured later gets to overrule that.
//   2. Otherwise the workspace's configured basis (import_policy / enrichment_policy .lawful_basis, 0091).
//   3. Otherwise the platform default below.
// Note the asymmetry in step 1: consent is the only basis a subject can grant, so it is the only one that can
// arrive with the payload — which is exactly why it must not be silently replaced by a workspace setting.

// DEFAULT_LAWFUL_BASIS is defined in the leaf package rather than here: packages/db builds forge-sync drafts
// directly and cannot import core without creating a dependency cycle, so both sides read ONE constant instead
// of keeping two that drift. Re-exported so this module stays the obvious place to look for it.
import {
  DEFAULT_LAWFUL_BASIS,
  type LawfulBasis,
  type ProvenanceSourceType,
} from "@leadwolf/types";

export { DEFAULT_LAWFUL_BASIS };

export interface LawfulBasisInput {
  /** Which channel the assertion arrived through. */
  sourceType: ProvenanceSourceType;
  /** A basis travelling with the payload — consentContext.basis on a capture. Highest precedence. */
  declared?: string | null;
  /** The workspace's configured basis (import_policy / enrichment_policy .lawful_basis). NULL = unset. */
  workspaceDefault?: string | null;
}

const VALID: ReadonlySet<string> = new Set<LawfulBasis>([
  "legitimate_interest",
  "consent",
  "contract",
  "public_record",
]);

/** Narrow an untrusted string to the shared vocabulary, or null. Both inputs cross a boundary — `declared`
 *  comes from a request body, `workspaceDefault` from a column an older migration could have left loose — so
 *  neither is trusted just because it is typed as a string upstream. */
function coerce(value: string | null | undefined): LawfulBasis | null {
  return value != null && VALID.has(value) ? (value as LawfulBasis) : null;
}

/**
 * Resolve the basis to stamp on a provenance event. Total: it always returns a member of the vocabulary, so a
 * caller can never be the reason an event is rejected by the NOT NULL — the failure mode 09 rule 4 cares about
 * (untagged data entering the graph) is prevented by the basis being mandatory, not by this function throwing.
 *
 * KNOWN LIMIT, stated so it is not mistaken for completeness: resolution is by WORKSPACE, not by the data
 * subject's jurisdiction. contacts.jurisdiction and contacts.region exist and a per-subject resolver is the
 * correct end state (09 § Regional gating), but that lands with the Phase 5 compliance work and its counsel
 * review. This is honest for a single-jurisdiction workspace and knowingly insufficient for one that spans
 * several — which is why the workspace column is nullable and the default is the conservative option.
 */
export function resolveLawfulBasis(input: LawfulBasisInput): LawfulBasis {
  return coerce(input.declared) ?? coerce(input.workspaceDefault) ?? DEFAULT_LAWFUL_BASIS;
}

/**
 * The source types that MUST carry a declared basis — the capture channels, where a human action created the
 * record and 09 rule 1 confines us to user-initiated collection. For these, falling back to a workspace
 * setting would be laundering a configuration value into a claim about what a person agreed to.
 *
 * Returns true when the basis is missing for such a source; the caller records the event with
 * acceptance_state='pending' rather than 'accepted', so it is auditable but does not project (rule 4:
 * anything untaggable doesn't enter the graph).
 */
export function requiresDeclaredBasis(sourceType: ProvenanceSourceType): boolean {
  return sourceType === "extension" || sourceType === "coop";
}

/** Whether an event from this source, with this input, may be accepted immediately. */
export function acceptanceFor(input: LawfulBasisInput): "accepted" | "pending" {
  return requiresDeclaredBasis(input.sourceType) && coerce(input.declared) == null
    ? "pending"
    : "accepted";
}
