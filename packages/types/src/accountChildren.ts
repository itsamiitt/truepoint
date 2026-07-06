// accountChildren.ts — Zod schemas + inferred types + constants for the company-overlay child layer
// (`account_domains` / `account_locations` + the accounts hierarchy/soft-delete columns —
// import-and-data-model-redesign 06 §API, THE spec; S-A1/S-A3/S-A4/S-A5). Additive, shared-Zod source of
// truth (platform contract): the account API shape evolves ADDITIVELY — list payloads keep the flat `domain`
// (primary cache) so existing consumers are untouched until they opt into the expanded shape (06 §API).
//
// STATUS: INERT. These shapes describe the API deltas the read cutover (S-A6) will emit; nothing produces or
// consumes them yet (no route reads a child row until S-A2 dual-write + S-A6 read cutover — the next task).
//
// NON-PII (deliberate contrast with contactChannels' masked summaries): domains and office addresses are
// public firmographics stored CLEAR (06 §1/§3), so these DTOs carry the ACTUAL values — no masking, no
// reveal gate. `AccountDomain`/`AccountLocation` match 06 §API exactly.

import { z } from "zod";

/** Provenance source for a domain/location child row (06 §1/§3) — mirrors the account_*_source_enum CHECK. */
export const accountChildSource = z.enum(["import", "enrichment", "manual", "master_suggestion"]);
export type AccountChildSource = z.infer<typeof accountChildSource>;

/** Office location kind (06 §3) — mirrors the account_locations_type_enum CHECK. */
export const accountLocationType = z.enum(["hq", "branch", "office"]);
export type AccountLocationType = z.infer<typeof accountLocationType>;

// ── AccountDomain (06 §API: { id, domain, isPrimary, verifiedAt, source, pinned }) ──────────────────────
/** One domain an account is known by. `domain` is clear (non-PII). The flat `accounts.domain` is the cache of
 *  the live `isPrimary` row; the whole live set is the C2 match input (06 §5). */
export const accountDomainSchema = z.object({
  id: z.string().uuid(),
  domain: z.string(),
  isPrimary: z.boolean(),
  verifiedAt: z.string().datetime({ offset: true }).nullable(), // ISO-8601; null = never confirmed live/owned
  source: accountChildSource,
  pinned: z.boolean(),
});
export type AccountDomain = z.infer<typeof accountDomainSchema>;

// ── AccountLocation (06 §API: { id, type, line1, line2, city, region, postalCode, country, isPrimary,
//    source, pinned }) ────────────────────────────────────────────────────────────────────────────────
/** One office. `country` is ISO-3166 alpha-2 or null (unmappable freetext at backfill — 06 §3). Subordinate
 *  to company identity — NEVER a dedup key (06 §3). No lineage pointer (07 §3 FK inventory omits it). */
export const accountLocationSchema = z.object({
  id: z.string().uuid(),
  type: accountLocationType,
  line1: z.string().nullable(),
  line2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().length(2).nullable(),
  isPrimary: z.boolean(),
  source: accountChildSource,
  pinned: z.boolean(),
});
export type AccountLocation = z.infer<typeof accountLocationSchema>;

// ── Hierarchy refs (06 §2/§API: GET /accounts/:id/family — depth-capped, visibility-filtered tree) ──────
/** One node in a family tree: a flat ref the family endpoint returns as a list for the client to assemble
 *  into a depth-capped tree. Hierarchy is display/rollup-only and NEVER widens visibility (06 §2, [47]) —
 *  the endpoint returns only rows the caller's RLS/visibility already admits, tombstones excluded. */
export const accountHierarchyRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  domain: z.string().nullable(), // the flat primary-domain cache
  parentAccountId: z.string().uuid().nullable(),
  rootAccountId: z.string().uuid().nullable(), // denormalized ultimate parent; family key = rootAccountId ?? id
});
export type AccountHierarchyRef = z.infer<typeof accountHierarchyRefSchema>;

// ── The additive account-detail overlay extension (06 §API: AccountSchema gains domains[]/locations[]/
//    parentAccountId/rootAccountId/deletedAt) ─────────────────────────────────────────────────────────
/** The additive slice the account-detail DTO gains at S-A6 read cutover — kept standalone (and inert) so no
 *  existing account consumer moves until it opts in. The grid DTO (maskedAccountSchema) is unchanged. */
export const accountOverlayExtensionSchema = z.object({
  domains: z.array(accountDomainSchema),
  locations: z.array(accountLocationSchema),
  parentAccountId: z.string().uuid().nullable(),
  rootAccountId: z.string().uuid().nullable(),
  deletedAt: z.string().datetime({ offset: true }).nullable(),
});
export type AccountOverlayExtension = z.infer<typeof accountOverlayExtensionSchema>;

// ── App-layer caps + hierarchy constants (06 §Misuse / §2 — enforced at the API edge, deliberately no DB
//    constraint; mirrors MAX_CHANNEL_VALUES_PER_CONTACT) ────────────────────────────────────────────────
/** Max live domains per account (06 §Misuse): generous × any legitimate company, blocks a hostile fanout. */
export const MAX_DOMAINS_PER_ACCOUNT = 50;
/** Max live locations per account (06 §Misuse). */
export const MAX_LOCATIONS_PER_ACCOUNT = 200;
/** Hierarchy depth ceiling (06 §2): D&B's 9-level code + practical CRM cap; keeps the cycle-guard CTE bounded. */
export const ACCOUNT_HIERARCHY_MAX_DEPTH = 10;
