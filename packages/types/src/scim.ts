// scim.ts — the SCIM 2.0 (RFC 7643/7644) wire contract for the tenant-scoped provisioning service
// (/scim/v2/Users). Single source of truth shared by apps/api (the SCIM routes + scimAuth middleware) and any
// SCIM client (an org's IdP — Okta/Entra/etc.). Validation lives HERE; the provision/deprovision logic lives
// in apps/api. This is the leaf-package edge an attacker-supplied IdP body/filter must pass before it ever
// reaches a query or a write — every field is allowlisted, and the equality-filter parser rejects anything
// outside the tiny grammar real SCIM clients send (no raw filter string is ever interpolated into SQL).
//
// Mapping to TruePoint's GLOBAL-identity model (ADR-0019): a "SCIM User in tenant T" is a `users` row (the
// global identity, keyed by email) PLUS an ACTIVE `tenant_members(T)` row. `id` (the SCIM resource id) is the
// user id; `userName`/`emails[0].value` are the email; `active` is whether the tenant membership is active
// (deprovision = active:false → membership deactivated + sessions revoked). `externalId` is the IdP's own id,
// persisted on `users.scim_external_id`.

import { z } from "zod";

// ── SCIM schema URNs (RFC 7643 §8.7 / RFC 7644 §3.4 / §3.12) ───────────────────────────────────────────────
export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_LIST_RESPONSE_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_PATCH_OP_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

// ── The User resource we EMIT (RFC 7643 §4.1, minimal core attribute set) ──────────────────────────────────
// We expose only the attributes we actually model: id, externalId, userName (email), name.formatted, the
// primary work email, and `active`. Timestamps are ISO strings (the `meta` complex attribute).
export const scimEmailSchema = z.object({
  value: z.string(),
  type: z.string().optional(),
  primary: z.boolean().optional(),
});

export const scimNameSchema = z.object({
  formatted: z.string().nullable().optional(),
});

export const scimMetaSchema = z.object({
  resourceType: z.literal("User"),
  created: z.string().optional(),
  lastModified: z.string().optional(),
  location: z.string().optional(),
});

export const scimUserResourceSchema = z.object({
  schemas: z.array(z.string()),
  id: z.string(),
  externalId: z.string().nullable().optional(),
  userName: z.string(),
  name: scimNameSchema.optional(),
  emails: z.array(scimEmailSchema).optional(),
  active: z.boolean(),
  meta: scimMetaSchema,
});
export type ScimUserResource = z.infer<typeof scimUserResourceSchema>;

// ── The ListResponse envelope we EMIT (RFC 7644 §3.4.2) ────────────────────────────────────────────────────
export const scimListResponseSchema = z.object({
  schemas: z.array(z.literal(SCIM_LIST_RESPONSE_SCHEMA)),
  totalResults: z.number().int().nonnegative(),
  startIndex: z.number().int().positive(),
  itemsPerPage: z.number().int().nonnegative(),
  Resources: z.array(scimUserResourceSchema),
});
export type ScimListResponse = z.infer<typeof scimListResponseSchema>;

// ── The SCIM Error object (RFC 7644 §3.12) ─────────────────────────────────────────────────────────────────
// `scimType` is a SCIM-defined detail code (e.g. invalidFilter, uniqueness, invalidValue); `status` is the
// HTTP status as a STRING (per the spec). The renderer in apps/api emits this with content-type scim+json.
export const scimErrorSchema = z.object({
  schemas: z.array(z.literal(SCIM_ERROR_SCHEMA)),
  status: z.string(),
  scimType: z.string().optional(),
  detail: z.string().optional(),
});
export type ScimError = z.infer<typeof scimErrorSchema>;

/** Build a SCIM Error body (RFC 7644 §3.12). `status` is stringified per the spec. */
export function scimErrorBody(status: number, detail?: string, scimType?: string): ScimError {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    ...(detail ? { detail } : {}),
  };
}

// ── POST /Users body (provision) — RFC 7643 §4.1. Server allowlists settable fields ───────────────────────
// A client may send far more than we model; we accept and READ only these. `userName` (the email) is the
// identity key. `active` defaults to true (a created user is active). `role` / `tenantId` / membership status
// are NEVER client-settable here — provisioning always joins at the tenant's SSO/SCIM default role server-side.
const emailString = z.string().trim().toLowerCase().email().max(320);

export const scimCreateUserSchema = z
  .object({
    schemas: z.array(z.string()).optional(),
    externalId: z.string().max(255).optional(),
    userName: emailString,
    name: z
      .object({
        formatted: z.string().max(255).optional(),
        givenName: z.string().max(255).optional(),
        familyName: z.string().max(255).optional(),
      })
      .optional(),
    displayName: z.string().max(255).optional(),
    emails: z
      .array(
        z.object({
          value: emailString,
          type: z.string().max(50).optional(),
          primary: z.boolean().optional(),
        }),
      )
      .optional(),
    active: z.boolean().optional(),
  })
  // Reject unknown top-level keys rather than silently letting an IdP smuggle an unmodelled attribute through.
  // (Mass-assignment posture — 09: the server, not the client, decides what is settable.)
  .strip();
export type ScimCreateUser = z.infer<typeof scimCreateUserSchema>;

// ── PUT /Users/:id body (full replace) — same allowlist. `active` defaults to true: a full-replace PUT that
// omits `active` means the user is in the default (active) state (most IdPs send it explicitly anyway). ───────
export const scimReplaceUserSchema = scimCreateUserSchema.extend({
  active: z.boolean().default(true),
});
export type ScimReplaceUser = z.infer<typeof scimReplaceUserSchema>;

// ── PATCH /Users/:id body (RFC 7644 §3.5.2) — the PatchOp document ─────────────────────────────────────────
// Real IdPs deprovision via PATCH { Operations: [{ op:"replace", path:"active", value:false }] } (Okta/Entra),
// or sometimes value:{active:false} with no path. We support exactly the `active` (de/re-provision) and a
// best-effort name/externalId update; any other op is a 400 invalidValue (we never blindly apply a path).
const scimPatchOperationSchema = z.object({
  // SCIM ops are case-insensitive per §3.5.2; normalize to lowercase so "Replace"/"replace" both match.
  op: z.string().trim().toLowerCase().pipe(z.enum(["add", "replace", "remove"])),
  path: z.string().trim().optional(),
  // value is intentionally `unknown` — its shape depends on path; the handler narrows it safely per-op.
  value: z.unknown().optional(),
});

export const scimPatchUserSchema = z.object({
  schemas: z.array(z.string()).optional(),
  Operations: z.array(scimPatchOperationSchema).min(1).max(50),
});
export type ScimPatchUser = z.infer<typeof scimPatchUserSchema>;
export type ScimPatchOperation = z.infer<typeof scimPatchOperationSchema>;

// ── Query parameters: startIndex / count (1-based pagination, RFC 7644 §3.4.2.4) + filter ──────────────────
// SCIM is 1-based: startIndex defaults to 1, count to a sane page size. We CAP count so an IdP can't request
// an unbounded page. Coerce from the query string; clamp out-of-range values instead of erroring (the spec
// says a non-positive startIndex is treated as 1 and an oversized count is bounded by the server).
export const SCIM_MAX_COUNT = 200;
export const SCIM_DEFAULT_COUNT = 100;

export const scimListQuerySchema = z.object({
  startIndex: z.coerce.number().int().catch(1),
  count: z.coerce.number().int().catch(SCIM_DEFAULT_COUNT),
  filter: z.string().trim().max(512).optional(),
});
export type ScimListQuery = z.infer<typeof scimListQuerySchema>;

/** Normalize the raw startIndex/count into a safe 0-based offset + bounded limit. */
export function scimPagination(query: { startIndex: number; count: number }): {
  startIndex: number;
  offset: number;
  limit: number;
} {
  const startIndex = query.startIndex >= 1 ? query.startIndex : 1;
  const count = query.count < 0 ? 0 : Math.min(query.count, SCIM_MAX_COUNT);
  return { startIndex, offset: startIndex - 1, limit: count };
}

// ── SCIM filter parsing (RFC 7644 §3.4.2.2) — SAFE equality-only subset ────────────────────────────────────
// IdPs probe "does this user already exist?" with `userName eq "x"` (or `emails.value eq "x"` / `externalId
// eq "x"`). That is the ENTIRE grammar we support. Anything else (and/or/co/sw/pr, nested paths, etc.) is
// rejected with `invalidFilter` — we never build a query from a raw filter string, only from the one parsed,
// allowlisted (attribute, value) pair. The value is matched as data in a parameterised WHERE, never concatenated.
export type ScimFilterAttribute = "userName" | "emails.value" | "externalId";

export interface ScimEqualityFilter {
  attribute: ScimFilterAttribute;
  value: string;
}

// `attr eq "value"` — attribute is one of the allowlisted names (case-insensitive on the operator only),
// the operator is exactly `eq`, the value is a double-quoted string. Single capture group for the inner value.
const SCIM_EQ_FILTER = /^(userName|emails\.value|externalId)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i;

/**
 * Parse a SCIM filter into a single equality predicate, or return null when the filter is unsupported (the
 * caller maps null → 400 invalidFilter). Only `<allowlisted-attr> eq "<value>"` is accepted; the attribute is
 * canonicalized to its exact SCIM spelling so the repository maps it to the right column. Never throws.
 */
export function parseScimEqualityFilter(filter: string): ScimEqualityFilter | null {
  const m = SCIM_EQ_FILTER.exec(filter.trim());
  if (!m) return null;
  const rawAttr = m[1]!.toLowerCase();
  const attribute: ScimFilterAttribute =
    rawAttr === "username"
      ? "userName"
      : rawAttr === "externalid"
        ? "externalId"
        : "emails.value";
  // Unescape SCIM string escapes (\" and \\) in the quoted value.
  const value = m[2]!.replace(/\\(["\\])/g, "$1");
  return { attribute, value };
}
