// compliance.ts — request DTOs for the compliance surface (08 §2/§3/§4): public DSAR intake, suppression
// entries, consent records. The closed vocab (scopes, match types, audit actions) lives in billing.ts.

import { z } from "zod";
import { suppressionMatchType, suppressionScope } from "./billing.ts";

export const dsarIntakeSchema = z.object({
  request_type: z.enum(["access", "delete", "rectify"]),
  email: z.string().email(),
});

export const suppressionCreateSchema = z.object({
  scope: suppressionScope.exclude(["global"]), // global rows are platform-managed (08 §3)
  match_type: suppressionMatchType.exclude(["phone"]), // phone blind-indexing lands with the verifier wiring
  email: z.string().email().optional(),
  domain: z.string().min(3).optional(),
  contact_id: z.string().uuid().optional(),
  reason: z.string().max(255).optional(),
});

export const lawfulBasis = z.enum(["legitimate_interest", "consent", "contract", "public_record"]);
export type LawfulBasis = z.infer<typeof lawfulBasis>;

export const consentCreateSchema = z.object({
  contact_id: z.string().uuid(),
  jurisdiction: z.string().length(2),
  lawful_basis: lawfulBasis,
  source: z.string().max(255).optional(),
});
