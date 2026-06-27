// pricingAdmin.ts — platform-admin credit-pack (pricing) config (13a Area 5, 13 §3.5, 07 §1/§1A). The
// catalog of credit packs staff author — the transparent, public pricing the commercial policy commits to
// (ADR-0012). This is the staff AUTHORING contract; surfacing packs to customers (the public pricing page) is
// a separate read surface. Shared by apps/api (validates) and apps/admin (derives its view type). Money is
// integer cents. The pack `key` is the stable identity (upsert is keyed on it).

import { z } from "zod";

/** Create or update a credit pack (idempotent on `key`). `priceCents` is the pack's price; `credits` the
 *  number of reveal credits it grants. `sortOrder` controls display order in the (future) public catalog. */
export const creditPackUpsertSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9_]+$/, "lowercase letters, digits and underscore only"),
  name: z.string().trim().min(1).max(120),
  credits: z.number().int().min(1).max(10_000_000),
  priceCents: z.number().int().min(0).max(100_000_000),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
export type CreditPackUpsertInput = z.infer<typeof creditPackUpsertSchema>;

/** Toggle a pack's availability (a retired pack stays for history but is no longer offered). */
export const creditPackSetActiveSchema = z.object({ active: z.boolean() });
export type CreditPackSetActiveInput = z.infer<typeof creditPackSetActiveSchema>;

/** A credit pack as shown in the console catalog. */
export const creditPackViewSchema = z.object({
  key: z.string(),
  name: z.string(),
  credits: z.number().int(),
  priceCents: z.number().int(),
  active: z.boolean(),
  sortOrder: z.number().int(),
  updatedAt: z.string(), // ISO-8601
});
export type CreditPackView = z.infer<typeof creditPackViewSchema>;
