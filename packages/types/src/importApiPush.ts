// importApiPush.ts — the shared contract for API-PUSH imports (import-and-data-model-redesign 08 §9
// "API-push imports": `POST /imports` graduates to a public contract — a JSON body variant [no multipart],
// same one-shot semantics, same limits/idempotency, the Salesforce-Bulk-2.0-shaped surface TruePoint gets
// nearly free because the durable job model already exists). This file is the ONE source of truth for the
// push request body + the per-tenant rollout flag key, shared by api (the route) so nobody re-types the shape.
//
// SCOPE (thin, per §9's pin): the caller sends ALREADY-STRUCTURED canonical contact rows as JSON — not a
// CSV file — plus the same envelope fields the multipart one-shot takes (source, merge strategy, list, delta
// opt-in). The rows ride the SAME fast-lane durable pipeline (createJob + enqueueFastImport) via an identity
// column-mapping (each present canonical field maps to itself). NDJSON framing + public-API PACKAGING (key
// minting, scopes, developer docs) are 08 §9's "doc 14 future" — this ships the body/limits/idempotency
// contract only, dark behind the dual gate.

import { z } from "zod";
import { canonicalContactRowSchema, conflictPolicy, sourceName } from "./contacts.ts";
import { importMergeMode } from "./importPolicy.ts";

/** Per-tenant rollout flag for API-push imports (seeded off in migration 0069; fail-closed). Mirrors
 *  IMPORT_V2_FLAG_KEY / DELTA_IMPORTS_FLAG_KEY — the shared key lives here so api can never drift. Effective
 *  push = the global API_IMPORTS_ENABLED env kill-switch AND this flag (both on ⇒ the surface activates). */
export const API_IMPORTS_FLAG_KEY = "api_imports_enabled";

/**
 * The API-push body row: a canonical contact row that must carry AT LEAST ONE field (an all-empty `{}` is a
 * 400 at the edge — a row with no identity key can only ever be rejected downstream, so refuse it up front).
 * Reuses `canonicalContactRowSchema` verbatim (ONE canonical shape; the same per-field max-lengths + email
 * validation the CSV path normalizes to) — the push surface adds only the non-empty refinement.
 */
export const apiPushRowSchema = canonicalContactRowSchema.refine(
  (r) => Object.values(r).some((v) => v != null && v !== ""),
  { message: "Each row must include at least one field." },
);

/**
 * The API-push one-shot request body (08 §9). Envelope + rows:
 *   • `sourceName` — the provenance origin (the same SourceName enum the CSV path takes; the caller declares
 *     where the data came from, e.g. their `salesforce`/`hubspot`/`manual` source).
 *   • `rows` — the structured canonical rows (bounded by the fast-lane row ceiling at the route; see below).
 *   • `mergeMode` / `preservePopulated` — the 08 §5 strategy pair (each optional; falls back to the workspace
 *     import_policy default at the route, exactly like the multipart path).
 *   • `conflictPolicy` — the legacy compatibility knob (mapped onto the triad when the v2 pair is absent).
 *   • `listId` — optional "import into list" target (validated against the verified workspace at the route).
 *   • `externalIdUpsert` — the 08 §9 delta opt-in (honored only under the DELTA_IMPORTS gate; inert otherwise).
 * `.strict()` — an unknown key is a 400, not silently ignored (a programmatic caller gets told it mistyped a
 * field rather than having it dropped).
 */
export const apiPushImportSchema = z
  .object({
    sourceName,
    rows: z.array(apiPushRowSchema).min(1, "At least one row is required."),
    mergeMode: importMergeMode.optional(),
    preservePopulated: z.boolean().optional(),
    conflictPolicy: conflictPolicy.optional(),
    listId: z.string().uuid().optional(),
    externalIdUpsert: z.boolean().optional(),
  })
  .strict();
export type ApiPushImportRequest = z.infer<typeof apiPushImportSchema>;
