// platformAdmin.ts — shared contracts for the platform-admin DIRECTORY surfaces (13a F5). The cross-tenant
// tenant/user lists are bounded; this is the query that adds a server-side search + keyset pagination so a
// platform with many orgs/users stays navigable (no offset, no unbounded scan — ADR-0032). Reused by the
// tenants and users directories; each backs it with an ILIKE search over its own columns and a keyset on the
// time-ordered v7 id.

import { z } from "zod";

/** A directory page request: an optional case-insensitive search, an opaque keyset cursor, a bounded limit.
 *  Values arrive as URL query params, so `limit` is coerced. */
export const platformListQuerySchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  // Exact account/lifecycle status filter (e.g. "active" | "suspended"), applied by listUsers and reusable by
  // other directories. A value the column never holds simply returns no rows — no enum coupling needed here.
  status: z.string().trim().min(1).max(40).optional(),
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PlatformListQuery = z.infer<typeof platformListQuerySchema>;
