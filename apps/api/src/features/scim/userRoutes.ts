// userRoutes.ts — the SCIM 2.0 /Users protocol surface (RFC 7643/7644) an org's IdP calls with a `scim_tokens`
// bearer token (enterprise IAM, 17 / ADR-0018; 09 "SCIM deprovisioning race & token abuse"). Mounted at
// /scim/v2 (DISJOINT from /api/v1) in app.ts. Transport only: scimAuth resolves the token → tenant, the body
// + filter are Zod-validated (@leadwolf/types), and the provision/deprovision/read logic lives in scimService.
//
//   GET    /Users         → list this tenant's members as SCIM Users (filter=…eq…, startIndex/count) → ListResponse
//   GET    /Users/:id     → one member (404 if not in this tenant)
//   POST   /Users         → provision: ensure identity + active membership (idempotent on (tenant, email)) → 201
//   PUT    /Users/:id     → full replace; `active:false` ⇒ DEPROVISION
//   PATCH  /Users/:id     → partial; the security-critical { op:replace, path:active, value:false } ⇒ DEPROVISION
//   DELETE /Users/:id     → DEPROVISION (deactivate membership + revoke sessions)
//
// EVERY route is behind scimAuth, and EVERY read/write is scoped to the token's tenantId — a token can only ever
// touch ITS tenant's members (the load-bearing isolation; a :id from another tenant 404s). SCIM responses use
// the SCIM error envelope + content-type application/scim+json (renderScimError), never RFC-9457 Problem Details.

import type { ScimMemberRow } from "@leadwolf/db";
import {
  SCIM_LIST_RESPONSE_SCHEMA,
  SCIM_USER_SCHEMA,
  type ScimListResponse,
  type ScimUserResource,
  parseScimEqualityFilter,
  scimCreateUserSchema,
  scimListQuerySchema,
  scimPagination,
  scimPatchUserSchema,
  scimReplaceUserSchema,
} from "@leadwolf/types";
import type { Context } from "hono";
import { Hono } from "hono";
import { type ScimVariables, scimAuth } from "./scimAuth.ts";
import {
  renderScimError,
  scimBadSyntax,
  scimInvalidFilter,
  scimInvalidValue,
  scimJson,
} from "./scimError.ts";
import {
  type ScimScope,
  deprovisionScimUser,
  findScimUserByEmail,
  findScimUserByExternalId,
  getScimUser,
  listScimUsers,
  provisionScimUser,
  reactivateScimUser,
} from "./scimService.ts";

export const scimUserRoutes = new Hono<{ Variables: ScimVariables }>();

// SCIM errors are the SCIM envelope (RFC 7644 §3.12), not Problem Details — render them here, before the error
// can reach the global Problem-Details onError. scimAuth (below) throws ScimHttpError, caught by this too.
scimUserRoutes.onError(renderScimError);

scimUserRoutes.use("*", scimAuth);

/** Read the resolved SCIM operation context (tenant + token id) from the request (set by scimAuth). */
function scopeOf(c: Context<{ Variables: ScimVariables }>): ScimScope {
  return { tenantId: c.get("tenantId"), scimTokenId: c.get("scimTokenId") };
}

/** Map a stored tenant-member row to the SCIM User resource we emit (RFC 7643 §4.1). */
function toScimResource(row: ScimMemberRow): ScimUserResource {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: row.userId,
    externalId: row.externalId ?? undefined,
    userName: row.email,
    name: { formatted: row.fullName },
    emails: [{ value: row.email, type: "work", primary: true }],
    active: row.active,
    meta: {
      resourceType: "User",
      created: row.createdAt.toISOString(),
      lastModified: row.createdAt.toISOString(),
      location: `/scim/v2/Users/${row.userId}`,
    },
  };
}

// ── GET /Users — list (filter + pagination) ────────────────────────────────────────────────────────────────
scimUserRoutes.get("/Users", async (c) => {
  const scope = scopeOf(c);
  // safeParse (not parse): the numeric fields .catch() to defaults, but `filter`'s .max(512) can still fail —
  // an oversized filter is an invalidFilter 400 (a SCIM error envelope), never a generic 500 from a thrown
  // ZodError reaching renderScimError.
  const parsedQuery = scimListQuerySchema.safeParse({
    startIndex: c.req.query("startIndex"),
    count: c.req.query("count"),
    filter: c.req.query("filter"),
  });
  if (!parsedQuery.success) throw scimInvalidFilter();
  const q = parsedQuery.data;
  const { startIndex, offset, limit } = scimPagination(q);

  // A `filter` is the IdP's existence probe — we support ONLY `<allowlisted-attr> eq "value"` and reject any
  // other expression with invalidFilter. The parsed (attribute, value) is matched as DATA (parameterised), the
  // raw filter string is never built into a query.
  if (q.filter !== undefined && q.filter !== "") {
    const parsed = parseScimEqualityFilter(q.filter);
    if (!parsed) throw scimInvalidFilter();
    // All three supported attributes (userName / emails.value / externalId) resolve to a single member; we
    // answer with userName/emails.value by email and externalId by the IdP id. Returned as a ListResponse
    // (0 or 1 result) — SCIM clients expect a list shape from a filtered GET, not a bare resource.
    let row: ScimMemberRow | null;
    if (parsed.attribute === "externalId") {
      // externalId probe: resolve via users.scim_external_id, tenant-scoped (RLS) like the by-email path, so an
      // externalId belonging to another tenant's user is a miss. Some IdPs (Entra) probe by externalId, not email.
      row = await findScimUserByExternalId(scope, parsed.value);
    } else {
      row = await findScimUserByEmail(scope, parsed.value);
    }
    const resources = row ? [toScimResource(row)] : [];
    const body: ScimListResponse = {
      schemas: [SCIM_LIST_RESPONSE_SCHEMA],
      totalResults: resources.length,
      startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    };
    return scimJson(c, body, 200);
  }

  const { total, members } = await listScimUsers(scope, { offset, limit });
  const resources = members.map(toScimResource);
  const body: ScimListResponse = {
    schemas: [SCIM_LIST_RESPONSE_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
  return scimJson(c, body, 200);
});

// ── GET /Users/:id — one member (404 if not in this tenant) ──────────────────────────────────────────────────
scimUserRoutes.get("/Users/:id", async (c) => {
  const row = await getScimUser(scopeOf(c), c.req.param("id"));
  return scimJson(c, toScimResource(row), 200);
});

// ── POST /Users — provision (idempotent on (tenant, email)) ──────────────────────────────────────────────────
scimUserRoutes.post("/Users", async (c) => {
  const parsed = scimCreateUserSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw scimBadSyntax("Invalid SCIM User payload.");
  const { row, created } = await provisionScimUser(scopeOf(c), parsed.data);
  // 201 on first provision; 200 when the user already existed (idempotent re-provision). Both echo the resource.
  return scimJson(c, toScimResource(row), created ? 201 : 200);
});

// ── PUT /Users/:id — full replace; active:false ⇒ deprovision ────────────────────────────────────────────────
scimUserRoutes.put("/Users/:id", async (c) => {
  const scope = scopeOf(c);
  const userId = c.req.param("id");
  const parsed = scimReplaceUserSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw scimBadSyntax("Invalid SCIM User payload.");

  // The resource must exist in THIS tenant (404 otherwise — never reveal another tenant's user).
  const current = await getScimUser(scope, userId);
  await applyActiveTransition(scope, current, parsed.data.active);
  const row = await getScimUser(scope, userId);
  return scimJson(c, toScimResource(row), 200);
});

// ── PATCH /Users/:id — partial; { op:replace, path:active, value:false } ⇒ deprovision ───────────────────────
scimUserRoutes.patch("/Users/:id", async (c) => {
  const scope = scopeOf(c);
  const userId = c.req.param("id");
  const parsed = scimPatchUserSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw scimBadSyntax("Invalid SCIM PatchOp payload.");

  const current = await getScimUser(scope, userId); // 404 if not in this tenant

  // Resolve the desired `active` from the operations. We support exactly the (de)activation patch IdPs send;
  // any other path/op is rejected (invalidValue) rather than silently ignored — we never blind-apply a patch.
  const desiredActive = extractActiveFromPatch(parsed.data.Operations);
  if (desiredActive === undefined) {
    // No `active` op present and nothing else we model — reject so the IdP knows the patch was not applied.
    throw scimInvalidValue("Only the `active` attribute is patchable on a SCIM User.");
  }
  await applyActiveTransition(scope, current, desiredActive);

  const row = await getScimUser(scope, userId);
  return scimJson(c, toScimResource(row), 200);
});

// ── DELETE /Users/:id — deprovision (deactivate + revoke sessions) ───────────────────────────────────────────
scimUserRoutes.delete("/Users/:id", async (c) => {
  const scope = scopeOf(c);
  const userId = c.req.param("id");
  // Must be a member of THIS tenant (404 otherwise). DELETE is a deprovision, not a hard delete: we keep the
  // global identity + the audit trail and flip the membership to deactivated, revoking live access.
  // deprovisionScimUser is idempotent (safe to call on an already-inactive member — it still revokes sessions).
  const current = await getScimUser(scope, userId);
  await deprovisionScimUser(scope, userId, current.email);
  // 204 No Content per RFC 7644 §3.6.
  return c.body(null, 204);
});

/** Apply an active:true/false transition to a member, reusing the audited service paths. No-op when unchanged. */
async function applyActiveTransition(
  scope: ScimScope,
  current: ScimMemberRow,
  active: boolean,
): Promise<void> {
  if (active === current.active) return; // idempotent — nothing changed
  if (active) {
    await reactivateScimUser(scope, current.userId);
  } else {
    await deprovisionScimUser(scope, current.userId, current.email);
  }
}

/**
 * Extract the desired `active` boolean from a SCIM PatchOp Operations array. Supports both shapes IdPs send:
 *   { op:"replace", path:"active", value:false }   and   { op:"replace", value:{ active:false } }
 * Returns the LAST `active` value found (a patch is applied in order), or undefined if no `active` op is present.
 * Any value that is present but not a boolean is a bad request (caller maps undefined→invalidValue; a non-bool
 * here is coerced to undefined so it is rejected rather than guessed).
 */
function extractActiveFromPatch(
  operations: { op: string; path?: string; value?: unknown }[],
): boolean | undefined {
  let result: boolean | undefined;
  for (const op of operations) {
    if (op.op === "remove") continue; // we don't model attribute removal
    const path = op.path?.trim().toLowerCase();
    if (path === "active") {
      if (typeof op.value === "boolean") result = op.value;
      else if (op.value === "true" || op.value === "false") result = op.value === "true";
    } else if (path === undefined && op.value && typeof op.value === "object") {
      // No-path replace: the value is a partial resource, e.g. { active:false }.
      const v = (op.value as Record<string, unknown>).active;
      if (typeof v === "boolean") result = v;
      else if (v === "true" || v === "false") result = v === "true";
    }
  }
  return result;
}
