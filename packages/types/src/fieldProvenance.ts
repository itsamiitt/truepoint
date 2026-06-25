// fieldProvenance.ts — Zod schema + inferred types for the field-level provenance descriptor (PLAN_03 §3.1).
// The substrate is ONE jsonb column holding only the WINNING descriptor per field, on BOTH the system-owned
// master rows (Layer 0) and the RLS-scoped overlay rows (Layer 1 — contacts/accounts). This is the overlay
// (Layer 1) slice: the scalar-field descriptor + the human-correction pin (PLAN_03 §1.4). The shape is
// validated AT THE APP EDGE (this schema), NOT by a DB CHECK — the house pattern for typed jsonb (mirrors
// customFields.ts; PLAN_03 §3.1). Keys are short on purpose: billions of golden rows × ~15 fields, so the map
// must stay inline/small-TOAST — every byte is paid for (PLAN_03 S1).

import { z } from "zod";

// ── The descriptor (PLAN_03 §3.1 — the winning-value tuple; closed, short-keyed, no PII) ───────────────────
/**
 * One JSON object per provenance-worthy field. `src` is a PLATFORM-level label — `"provider:zoominfo"` |
 * `"import:apollo"` | `"user_edit"` | `"reveal"` | `"master"` — and is NEVER a workspace id (PLAN_03 §C2: the
 * descriptor must never name a contributing workspace / co-op source). `pin=true` marks a human correction that
 * BLOCKS later overwrite (PLAN_03 §1.4). PII is referenced, never copied here: email/phone channel provenance
 * is deferred to the reveal/channel layer (Phase 4 `revealed_channels`), not this scalar slice.
 */
export const fieldProvenanceDescriptorSchema = z.object({
  /** Platform-level source label (e.g. "provider:zoominfo" | "import:apollo" | "user_edit" | "reveal" | "master"). NEVER a workspace id (C2). */
  src: z.string().max(50),
  /** match_method that produced the value (the matchKeys ladder). */
  mth: z.string().max(30).optional(),
  /** Field confidence ∈ [0,1] (PLAN_03 §1.2). */
  conf: z.number().min(0).max(1).optional(),
  /** observed_at (VALID-time: when the source asserts the fact held) — ISO string. */
  obs: z.string().optional(),
  /** last_verified_at (set by a verification run) — ISO string. */
  ver: z.string().optional(),
  /** is_pinned — a human override that blocks overwrite (PLAN_03 §1.4). */
  pin: z.boolean().optional(),
  /** pin actor (user_id | steward_id) — present iff pin=true. */
  by: z.string().optional(),
  /** pin timestamp (ISO string) — present iff pin=true. */
  at: z.string().optional(),
});
export type FieldProvenanceDescriptor = z.infer<typeof fieldProvenanceDescriptorSchema>;

// ── The map: { field → winning descriptor } (PLAN_03 §3.1) ─────────────────────────────────────────────────
/** The whole `field_provenance` jsonb column: one descriptor per provenance-worthy field key. */
export type FieldProvenanceMap = Record<string, FieldProvenanceDescriptor>;
export const fieldProvenanceMapSchema = z.record(z.string(), fieldProvenanceDescriptorSchema);

// ── The scalar overlay profile fields the pin protects (1:1 with contact columns) ──────────────────────────
/**
 * The closed set of SCALAR overlay fields this pin slice protects — each maps 1:1 to a `contacts` column
 * (PLAN_03 §3.4 namespace, overlay subset). A user-edit pin on any of these blocks a later reveal/enrichment
 * overwrite (PLAN_03 §1.4 overlay merge). NOTE: email/phone channel provenance is DEFERRED to the
 * reveal/channel layer (Phase 4 `revealed_channels`), not this scalar-pin slice.
 */
export const CONTACT_PROVENANCE_FIELDS = [
  "firstName",
  "lastName",
  "jobTitle",
  "seniorityLevel",
  "department",
  "locationCountry",
  "locationCity",
] as const;
