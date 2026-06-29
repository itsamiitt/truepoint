// planTemplateAdmin.ts — platform-admin plan/entitlement TEMPLATE config (13a Area 5, 13 §3.5, 07 §5). The
// catalog of plan templates staff author: the seat/workspace caps, optional monthly credit grant, and the
// `features` entitlement flags each plan grants. This is the staff AUTHORING contract; applying a template to
// a tenant (the plan-override path) and any public plan comparison are separate surfaces. Shared by apps/api
// (validates) and apps/admin (derives its view type). `key` is the stable identity (upsert keyed on it).

import { z } from "zod";

/** Create or update a plan template (idempotent on `key`). `workspaceLimit`/`monthlyCreditGrant` null = no
 *  cap / no grant. `features` is the entitlement flag set (feature key → enabled). */
export const planTemplateUpsertSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9_]+$/, "lowercase letters, digits and underscore only"),
  name: z.string().trim().min(1).max(120),
  seatLimit: z.number().int().min(0).max(1_000_000),
  workspaceLimit: z.number().int().min(0).max(1_000_000).nullable(),
  monthlyCreditGrant: z.number().int().min(0).max(100_000_000).nullable(),
  features: z.record(z.boolean()).default({}),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
export type PlanTemplateUpsertInput = z.infer<typeof planTemplateUpsertSchema>;

/** Toggle a template's availability (a retired plan stays for history but is no longer offered). */
export const planTemplateSetActiveSchema = z.object({ active: z.boolean() });
export type PlanTemplateSetActiveInput = z.infer<typeof planTemplateSetActiveSchema>;

/** A plan template as shown in the console catalog. */
export const planTemplateViewSchema = z.object({
  key: z.string(),
  name: z.string(),
  seatLimit: z.number().int(),
  workspaceLimit: z.number().int().nullable(),
  monthlyCreditGrant: z.number().int().nullable(),
  features: z.record(z.boolean()),
  active: z.boolean(),
  sortOrder: z.number().int(),
  updatedAt: z.string(), // ISO-8601
});
export type PlanTemplateView = z.infer<typeof planTemplateViewSchema>;
