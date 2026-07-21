// voyager/identity/profiles parser @ 1-0-0 (08 §M-FORGE-B.1). Pure · deterministic · total · PII-minimizing ·
// provenance-emitting (the five invariants). Deterministic STRUCTURE extraction from the known Voyager shape;
// free-text (bios) is left for the AI-extract stage (09). Channel PII → HMAC blind index only, never a clear
// value in `fields` (invariant 3).
import { blindIndex, normalizeEmail } from "../blindIndex.ts";
import { type ParseError, type ParseResult, type Parser, field } from "../parser.ts";

export const VOYAGER_PROFILE_ENDPOINT = "voyager/identity/profiles";
/** Sorted top-level keys of the canonical Voyager profile shape (matches shapeFingerprint of a v1 payload). */
export const VOYAGER_PROFILE_FINGERPRINT =
  "firstName,geoLocationName,headline,lastName,publicIdentifier";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** "VP Engineering at Acme" → "VP Engineering" (deterministic normalize, not a model call). */
function titleFromHeadline(headline: string | null): string | null {
  if (!headline) return null;
  const parts = headline.split(/\s+at\s+/i);
  return (parts[0] ?? headline).trim() || null;
}

function blockKey(lastName: string | null, firstName: string | null): string {
  const base = (lastName ?? firstName ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return base.slice(0, 4);
}

export const voyagerProfileParserV1: Parser = (input) => {
  const errors: ParseError[] = [];
  const fields: ParseResult["fields"] = [];
  const channels: ParseResult["channels"] = {};

  const raw = input.rawPayload;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      entityKind: "person",
      fields: [],
      channels: {},
      blockKey: "",
      errors: [{ code: "UNEXPECTED_SHAPE", message: "rawPayload is not a JSON object" }],
      status: "quarantined",
    };
  }
  const p = raw as Record<string, unknown>;

  const firstName = str(p.firstName);
  const lastName = str(p.lastName);
  const headline = str(p.headline);
  const location = str(p.geoLocationName);
  const publicId = str(p.publicIdentifier);

  field(fields, "first_name", firstName, "firstName", "identity", true);
  field(fields, "last_name", lastName, "lastName", "identity", true);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || null;
  field(fields, "full_name", fullName, "firstName+lastName", "derive", true);
  field(fields, "job_title", titleFromHeadline(headline), "headline", "normalize");
  field(fields, "location", location, "geoLocationName", "identity");
  field(fields, "linkedin_public_id", publicId, "publicIdentifier", "identity");

  // Channel PII → blind index only (invariant 3): never a clear email in `fields`.
  const email = str(p.emailAddress);
  if (email) channels.emailBlindIndex = blindIndex(normalizeEmail(email));

  if (!firstName && !lastName) {
    errors.push({
      code: "MISSING_REQUIRED",
      fieldPath: "full_name",
      message: "no name fields present",
    });
  }

  const status: ParseResult["status"] = errors.some((e) => e.code === "MISSING_REQUIRED")
    ? "partial"
    : "parsed";

  return {
    entityKind: "person",
    fields,
    channels,
    blockKey: blockKey(lastName, firstName),
    errors,
    status,
  };
};
