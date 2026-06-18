// types.ts — view shapes for the Workspace ▸ Auto-enrich settings panel (G-ENR-1; 29 §3). Mirrors the
// @leadwolf/types EnrichmentPolicyResponse contract; the labels/options drive the form controls. Budget is
// stored in micros (millionths of a credit) on the wire; the panel edits a whole-credit number and converts.

import type { EnrichField, EnrichTrigger, EnrichmentPolicyResponse } from "@leadwolf/types";

/**
 * The resolved policy + month-to-date spend, as returned by GET/PATCH /settings/auto-enrich. Aliased to the
 * canonical wire contract in @leadwolf/types so the web client can never drift from the server shape.
 */
export type AutoEnrichPolicy = EnrichmentPolicyResponse;

/** The trigger options shown as toggles, in display order. */
export const TRIGGER_OPTIONS: { value: EnrichTrigger; label: string; hint: string }[] = [
  { value: "on_import", label: "On import", hint: "Enrich freshly imported records." },
  { value: "on_reveal", label: "On reveal", hint: "Fill remaining fields after a reveal." },
  { value: "on_stale", label: "On stale", hint: "Re-enrich records past their freshness window." },
];

/** The field options for the allowlist, in display order. */
export const FIELD_OPTIONS: { value: EnrichField; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "jobTitle", label: "Job title" },
  { value: "seniorityLevel", label: "Seniority" },
  { value: "department", label: "Department" },
];

/** 1 credit = 1,000,000 micros (the provider_calls.cost_micros unit). */
export const MICROS_PER_CREDIT = 1_000_000;

export function microsToCredits(micros: number): number {
  return Math.round(micros / MICROS_PER_CREDIT);
}
export function creditsToMicros(credits: number): number {
  return Math.max(0, Math.round(credits)) * MICROS_PER_CREDIT;
}
