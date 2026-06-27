// twilioPhoneVerifier.ts — the Twilio Lookup phone-verification adapter (06 §9, 01 §5.3) implementing
// PhoneVerifierPort. Twilio Lookup v2 `GET /v2/PhoneNumbers/{E164}` returns `valid` (carrier-confirmed) — a real
// upgrade over the E.164 regex. The HTTP call is INJECTABLE (`fetchJson`) so tests run offline with zero spend,
// mirroring the email verifier. Basic-auth with the Account SID + Auth Token (a SECRET — env/KMS only, never
// client-exposed). A non-2xx or transport error degrades to the E.164 FORMAT check (validatePhone) — never worse
// than today, and it never throws (verification runs OUTSIDE the charging tx, 14 §3.5).
//
// SCOPE (v1): basic validation only (cost-minimal — the `valid` field). The carrier LINE-TYPE (mobile/landline/
// voip for TCPA gating, 01 §5.3) is the migration-gated follow-up: it needs a `phone_line_type` column +
// Twilio's PAID line_type_intelligence `Fields` add-on, so it is intentionally NOT requested here.

import { env } from "@leadwolf/config";
import type { PhoneStatus } from "@leadwolf/types";
import { type PhoneVerifierPort, formatOnlyPhoneVerifier } from "./phoneVerifier.ts";
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

/** Map a Twilio Lookup v2 payload to a PhoneStatus. `valid:true`→`valid`, `valid:false`→`invalid`; an
 *  unparseable / missing `valid` returns null so the caller falls back to the E.164 format check. */
export function twilioStatusFrom(json: unknown): PhoneStatus | null {
  if (typeof json !== "object" || json === null) return null;
  const valid = (json as Record<string, unknown>).valid;
  if (valid === true) return "valid";
  if (valid === false) return "invalid";
  return null;
}

export interface TwilioPhoneVerifierOptions {
  accountSid: string;
  authToken: string;
  fetchJson?: PhoneLookupFetch | undefined;
  /** Base origin of the Lookup API; defaults to Twilio's. Override for a regional/proxy endpoint. */
  baseUrl?: string | undefined;
}

/**
 * A verifier backed by Twilio Lookup v2. A non-2xx response or a transport throw degrades to the E.164 format
 * check (validatePhone) — never worse than today; it never throws, so a Lookup outage cannot fail a reveal.
 */
export function twilioLookupVerifier(opts: TwilioPhoneVerifierOptions): PhoneVerifierPort {
  const fetchJson = opts.fetchJson ?? defaultLookupFetch;
  const base = (opts.baseUrl ?? "https://lookups.twilio.com").replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64")}`;
  return {
    name: "twilio_lookup",
    async verify(phoneE164: string, _currentStatus: PhoneStatus | null): Promise<PhoneStatus> {
      try {
        const url = `${base}/v2/PhoneNumbers/${encodeURIComponent(phoneE164)}`;
        const { status, json } = await fetchJson(url, { headers: { authorization: auth } });
        if (status < 200 || status >= 300) return validatePhone(phoneE164); // didn't run → format floor
        return twilioStatusFrom(json) ?? validatePhone(phoneE164);
      } catch {
        return validatePhone(phoneE164); // transport error → format floor; never fail the reveal
      }
    },
  };
}

/**
 * The configured phone verifier for the reveal/reverify paths (06 §9). Twilio Lookup when BOTH
 * TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN are set (carrier-confirmed valid/invalid), else the E.164 format check
 * (today's behaviour preserved). The carrier line-type (TCPA) upgrade is migration-gated (13 §6 item 1).
 */
export function defaultPhoneVerifier(fetchJson?: PhoneLookupFetch): PhoneVerifierPort {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return formatOnlyPhoneVerifier;
  return twilioLookupVerifier({ accountSid, authToken, fetchJson });
}
