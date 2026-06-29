// retentionAdmin.ts — platform-admin retention-policy config (13a Area 8, 13 §3.8). The compliance officer
// authors how long each entity (optionally a specific field) is retained — the freshness/retention SLAs the
// retention sweep enforces. This is the AUTHORING contract; the sweep that applies it is a separate worker.
// Shared by apps/api (validates) and apps/admin (derives its view type).

import { z } from "zod";

/** The entities a retention policy can target. */
export const retentionEntity = z.enum([
  "contact",
  "account",
  "activity",
  "audit_log",
  "import",
  "reveal",
]);
export type RetentionEntity = z.infer<typeof retentionEntity>;

/** Create or update a retention policy. `field` null = the whole entity; `retentionDays` is the SLA. */
export const retentionPolicyUpsertSchema = z.object({
  entity: retentionEntity,
  field: z.string().trim().min(1).max(64).nullable().default(null),
  retentionDays: z.number().int().min(1).max(36500),
  reason: z.string().trim().max(500).nullable().default(null),
});
export type RetentionPolicyUpsertInput = z.infer<typeof retentionPolicyUpsertSchema>;

/** Toggle a policy on/off (a retired policy stays for history). */
export const retentionPolicySetActiveSchema = z.object({ active: z.boolean() });
export type RetentionPolicySetActiveInput = z.infer<typeof retentionPolicySetActiveSchema>;

/** A retention policy as shown in the console. */
export const retentionPolicyViewSchema = z.object({
  id: z.string().uuid(),
  entity: retentionEntity,
  field: z.string().nullable(),
  retentionDays: z.number().int(),
  reason: z.string().nullable(),
  active: z.boolean(),
  updatedAt: z.string(), // ISO-8601
});
export type RetentionPolicyView = z.infer<typeof retentionPolicyViewSchema>;
