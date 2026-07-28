// transforms.ts — the CLOSED registry of vetted field transforms (crm-sync 00 §1.3 non-goals / §4.3).
//
// crm_field_mappings.transform stores a NAME, not code. That is the security decision this file implements:
// a customer-authored transform would be an eval surface reachable from a tenant-editable table, so the
// plan's non-goals rule it out explicitly. Every transform here is a pure function chosen from a fixed set;
// an unknown name resolves to a REFUSAL, not to passthrough (see applyTransform).
//
// Transforms run on the INBOUND path (CRM value -> TP value) and on the OUTBOUND path (TP value -> CRM
// value). Most are symmetric enough to share one implementation; where they are not, the direction is an
// argument rather than two half-registries that can drift.
//
// A transform NEVER throws. A value it cannot handle yields `{ ok: false }` and the caller records a
// per-field skip — one malformed phone number in a 200-record page must not fail the page.

import type { CrmTransform } from "@leadwolf/types";
import { toE164 } from "../enrichment/matchKeys.ts";

export type TransformDirection = "inbound" | "outbound";

export interface TransformResult {
  ok: boolean;
  /** The converted value. Only meaningful when ok === true. */
  value?: unknown;
  /** Why the conversion was refused — a stable code, safe to log (never the value itself). */
  reason?: string;
}

/** Config for the parameterised transforms, read from crm_field_mappings.transform_config. */
export interface TransformConfig {
  /** picklist_map: CRM value -> TP value. The inverse is derived for the outbound direction. */
  map?: Record<string, string>;
  /** phone_e164: the region to assume for a national-format number with no country code. */
  defaultRegion?: string;
}

const SENIORITY_SYNONYMS: Record<string, string> = {
  // The TP enum is seniorityLevel: c_suite | vp | director | manager | ic | other (types/contacts.ts).
  // CRMs carry free text here, so this is a best-effort normalisation of the common shapes. Anything
  // unrecognised maps to `other` rather than being refused: a title we cannot classify is still a contact.
  ceo: "c_suite",
  cto: "c_suite",
  cfo: "c_suite",
  coo: "c_suite",
  cmo: "c_suite",
  cio: "c_suite",
  founder: "c_suite",
  cofounder: "c_suite",
  "c-suite": "c_suite",
  "c suite": "c_suite",
  chief: "c_suite",
  president: "c_suite",
  owner: "c_suite",
  vp: "vp",
  "vice president": "vp",
  svp: "vp",
  evp: "vp",
  avp: "vp",
  head: "vp",
  director: "director",
  "sr director": "director",
  "senior director": "director",
  manager: "manager",
  "sr manager": "manager",
  "senior manager": "manager",
  lead: "manager",
  supervisor: "manager",
  ic: "ic",
  individual: "ic",
  "individual contributor": "ic",
  associate: "ic",
  analyst: "ic",
  specialist: "ic",
  engineer: "ic",
  consultant: "ic",
};

const VALID_SENIORITY = new Set(["c_suite", "vp", "director", "manager", "ic", "other"]);

function asText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * Map free-text seniority onto the TP enum.
 *
 * Substring matching against the synonym table, longest key first — "senior director" must win over
 * "director", and "vice president" over "president". Sorting by length is what makes that deterministic
 * instead of dependent on object key order.
 */
function mapSeniority(raw: string): string {
  const text = raw.trim().toLowerCase();
  if (VALID_SENIORITY.has(text)) return text; // already canonical
  const keys = Object.keys(SENIORITY_SYNONYMS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (text.includes(key)) return SENIORITY_SYNONYMS[key] as string;
  }
  return "other";
}

/**
 * Apply a named transform.
 *
 * An UNKNOWN name returns ok:false rather than falling through to passthrough. A mapping row naming a
 * transform this build does not have means the row was written by a newer version (or by hand); passing the
 * raw value through would silently write unconverted data into a customer's CRM or into TruePoint, which is
 * worse than skipping the field and recording why.
 */
export function applyTransform(
  transform: CrmTransform | string,
  value: unknown,
  direction: TransformDirection = "inbound",
  config: TransformConfig = {},
): TransformResult {
  // null/undefined are gaps, not errors — every transform treats them as "nothing to convert".
  if (value === null || value === undefined) return { ok: true, value: null };

  switch (transform) {
    case "passthrough":
      return { ok: true, value };

    case "lowercase": {
      const text = asText(value);
      if (text === null) return { ok: false, reason: "not_text" };
      return { ok: true, value: text.trim().toLowerCase() };
    }

    case "phone_e164": {
      const text = asText(value);
      if (text === null) return { ok: false, reason: "not_text" };
      const e164 = toE164(text, config.defaultRegion as Parameters<typeof toE164>[1] | undefined);
      // Refused rather than passed through: an unparseable phone written to a CRM as-is corrupts the
      // customer's record, and written into TP breaks the E.164 assumption every dedup key makes.
      if (!e164) return { ok: false, reason: "unparseable_phone" };
      return { ok: true, value: e164 };
    }

    case "date_iso": {
      const text = asText(value);
      if (text === null) return { ok: false, reason: "not_text" };
      const ms = Date.parse(text);
      if (Number.isNaN(ms)) return { ok: false, reason: "unparseable_date" };
      return { ok: true, value: new Date(ms).toISOString() };
    }

    case "seniority_map": {
      const text = asText(value);
      if (text === null) return { ok: false, reason: "not_text" };
      if (direction === "outbound") {
        // Outbound has no canonical target vocabulary — the customer's CRM picklist is theirs. Send the TP
        // enum value as-is rather than inventing a label their picklist may reject.
        return { ok: true, value: text };
      }
      return { ok: true, value: mapSeniority(text) };
    }

    case "picklist_map": {
      const text = asText(value);
      if (text === null) return { ok: false, reason: "not_text" };
      const map = config.map ?? {};
      if (direction === "inbound") {
        const mapped = map[text] ?? map[text.toLowerCase()];
        // An unmapped picklist value is a CONFIGURATION gap, not a data error. Refusing surfaces it on the
        // field's skip reason; guessing would write an arbitrary string into a typed TP field.
        if (mapped === undefined) return { ok: false, reason: "unmapped_picklist_value" };
        return { ok: true, value: mapped };
      }
      // Outbound: invert the map. A TP value with two CRM spellings is ambiguous, so the FIRST wins and the
      // ordering is the mapping author's — deterministic, and visible in the editor.
      for (const [crmValue, tpValue] of Object.entries(map)) {
        if (tpValue === text) return { ok: true, value: crmValue };
      }
      return { ok: false, reason: "unmapped_picklist_value" };
    }

    default:
      return { ok: false, reason: "unknown_transform" };
  }
}

/**
 * Convert a whole CRM record into TP field values using the mapping rows.
 *
 * Returns the converted values plus the per-field refusals, so the caller can count them onto the run
 * ledger. A refused field is OMITTED rather than written as null — writing null would clear a TP field
 * because a CRM value failed to parse, which is destructive and the opposite of what the operator asked for.
 */
export function transformInbound(
  mappings: Array<{
    tpField: string;
    crmField: string;
    transform: string;
    transformConfig?: TransformConfig | null;
  }>,
  crmRecord: Record<string, unknown>,
): { values: Record<string, unknown>; refused: Array<{ tpField: string; reason: string }> } {
  const values: Record<string, unknown> = {};
  const refused: Array<{ tpField: string; reason: string }> = [];

  for (const m of mappings) {
    const raw = crmRecord[m.crmField];
    if (raw === undefined) continue; // the CRM did not send this field at all — not a refusal
    const result = applyTransform(m.transform, raw, "inbound", m.transformConfig ?? {});
    if (!result.ok) {
      refused.push({ tpField: m.tpField, reason: result.reason ?? "transform_failed" });
      continue;
    }
    if (result.value !== null) values[m.tpField] = result.value;
  }

  return { values, refused };
}
