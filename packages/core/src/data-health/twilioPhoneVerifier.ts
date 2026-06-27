// twilioPhoneVerifier.ts — the Twilio Lookup phone-verification adapter (06 §9, 01 §5.3) implementing
// PhoneVerifierPort. Twilio Lookup v2 `GET /v2/PhoneNumbers/{E164}?Fields=line_type_intelligence` returns
// `valid` (carrier-confirmed) + line_type_intelligence.type (the carrier line type). The HTTP call is INJECTABLE
// (`fetchJson`) so tests run offline with zero spend. Basic-auth with the Account SID + Auth Token (a SECRET —
// env/KMS only, never client-exposed). A non-2xx or transport error degrades to the E.164 FORMAT check
// (validatePhone) with no line type — never worse than today, and it never throws (verification runs OUTSIDE the
// charging tx, 14 §3.5). NOTE: line_type_intelligence is a PAID Twilio add-on (the TCPA mobile/landline signal);
// it is requested here because the line type is now persisted (contacts.phone_line_type).

import { env } from "@leadwolf/config";
import type { PhoneLineType, PhoneStatus } from "@leadwolf/types";
import {
  formatOnlyPhoneVerifier,
  type PhoneVerifierPort,
  type PhoneVerifyResult,
} from "./phoneVerifier.ts";
import { validatePhone } from "./validatePhone.ts";

/** Injectable GET→JSON so the adapter is testable offline (the GET analog of the email verifier's VerifierFetch). */
export type PhoneLookupFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ status: number; json: unknown }>;

const defaultLookupFetch: PhoneLookupFetch = async (url, init) => {
  const res = await fetch(url, { method: "GET", headers: init.headers });
  return { status: res.status, json: await res.json().catch(() => null) };
};

/** Map Twilio Lookup `valid` → PhoneStatus. `true`→`valid`, `false`→`invalid`; missing → null (caller falls back). */
export function twilioStatusFrom(json: unknown): PhoneStatus | null {
  if (typeof json !== "object" || json === null) return null;
  const valid = (json as Record<string, unknown>).valid;
  if (valid === true) return "valid";
  if (valid === false) return "invalid";
  return null;
}

/** Map Twilio line_type_intelligence.type → PhoneLineType. fixedVoip/nonFixedVoip → voip; mobile/landline pass
 *  through; anything else (tollFree/personal/voicemail/uan/null/…) → unknown. Returns null when absent. */
export function twilioLineTypeFrom(json: unknown): PhoneLineType | null {
  if (typeof json !== "object" || json === null) return null;
  const lti = (json as Record<string, unknown>).line_type_intelligence;
  if (typeof lti !== "object" || lti === null) return null;
  switch ((lti as Record<string, unknown>).type) {
    case "mobile":
      return "mobile";
    case "landline":
      return "landline";
    case "fixedVoip":
    case "nonFixedVoip":
      return "voip";
    default:
      return "unknown"; // tollFree / personal / voicemail / uan / null / unrecognized → unclassified
  }
}

export interface TwilioPhoneVerifierOptions {
  accountSid: string;
  authToken: string;
  fetchJson?: PhoneLookupFetch | undefined;
  /** Base origin of the Lookup API; defaults to Twilio's. Override for a regional/proxy endpoint. */
  baseUrl?: string | undefined;
}

/**
 * A verifier backed by Twilio Lookup v2 (validity + carrier line type). A non-2xx response or a transport throw
 * degrades to the E.164 format check (validatePhone) with no line type — never worse than today; it never throws.
 */
export function twilioLookupVerifier(opts: TwilioPhoneVerifierOptions): PhoneVerifierPort {
  const fetchJson = opts.fetchJson ?? defaultLookupFetch;
  const base = (opts.baseUrl ?? "https://lookups.twilio.com").replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64")}`;
  return {
    name: "twilio_lookup",
    async verify(phoneE164: string, _currentStatus: PhoneStatus | null): Promise<PhoneVerifyResult> {
      try {
        const url = `${base}/v2/PhoneNumbers/${encodeURIComponent(phoneE164)}?Fields=line_type_intelligence`;
        const { status, json } = await fetchJson(url, { headers: { authorization: auth } });
        if (status < 200 || status >= 300) return { status: validatePhone(phoneE164), lineType: null };
        const s = twilioStatusFrom(json) ?? validatePhone(phoneE164);
        // Trust a line type only for a carrier-valid number; an invalid / format-fallback number has none.
        const lineType = s === "valid" ? twilioLineTypeFrom(json) : null;
        return { status: s, lineType };
      } catch {
        return { status: validatePhone(phoneE164), lineType: null }; // transport error → format floor, no line type
      }
    },
  };
}

/**
 * The configured phone verifier for the reveal/reverify paths (06 §9). Twilio Lookup when BOTH
 * TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN are set (carrier-confirmed valid/invalid + line type), else the E.164
 * format check (today's behaviour preserved).
 */
export function defaultPhoneVerifier(fetchJson?: PhoneLookupFetch): PhoneVerifierPort {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return formatOnlyPhoneVerifier;
  return twilioLookupVerifier({ accountSid, authToken, fetchJson });
}
