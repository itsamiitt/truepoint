// channelBackfill.test.ts — unit tests for S-CH3's pure batch decider (planContactChannelBackfill,
// 15 §2.1): email bytes pass through VERBATIM (same references — never re-encrypted, never decrypted here);
// phone derivation reuses the S-CH2 builder (decrypt happens in the runner; the decider takes the
// plaintext); unparseable kept raw with NULL e164 material; decrypt-failure/incomplete-flat contacts are
// SKIPPED (left in the completeness count, never half-written); out-of-vocabulary legacy grades are
// sanitized per 05 §Edge (line_type → 'unknown'; phone_status → NULL). The test preload (test/setup.ts)
// seeds BLIND_INDEX_KEY, so the DM1 primitives run for real — no DB.

import { describe, expect, test } from "bun:test";
import type { MissingChannelProjectionRow } from "@leadwolf/db";
import { blindIndex } from "../import/blindIndex.ts";
import { decryptPii, encryptPii } from "../import/encryptPii.ts";
import { planContactChannelBackfill } from "./channelBackfill.ts";

const EMAIL = "jane@acme.com";
const PHONE = "(415) 555-2671";

function row(overrides: Partial<MissingChannelProjectionRow> = {}): MissingChannelProjectionRow {
  return {
    id: "0197a000-0000-7000-8000-000000000001",
    needsEmail: false,
    needsPhone: false,
    emailEnc: null,
    emailBlindIndex: null,
    emailDomain: null,
    emailStatus: "unverified",
    phoneEnc: null,
    phoneStatus: null,
    phoneLineType: null,
    locationCountry: null,
    ...overrides,
  };
}

describe("planContactChannelBackfill — email leg (verbatim bytes, CH-INV-1 by construction)", () => {
  test("copies the flat ciphertext + blind index BY REFERENCE and mirrors domain + status", () => {
    const emailEnc = encryptPii(EMAIL);
    const emailBlindIndex = blindIndex(EMAIL);
    const plan = planContactChannelBackfill(
      row({
        needsEmail: true,
        emailEnc,
        emailBlindIndex,
        emailDomain: "acme.com",
        emailStatus: "valid",
      }),
      null,
    );
    expect(plan.email).toBeDefined();
    // Byte-verbatim means the SAME bytes — the decider never re-encrypts, re-normalizes, or decrypts email.
    expect(plan.email?.valueEnc).toBe(emailEnc);
    expect(plan.email?.blindIndex).toBe(emailBlindIndex);
    expect(plan.email?.emailDomain).toBe("acme.com");
    expect(plan.email?.status).toBe("valid");
    expect(plan.emailSkipped).toBe(false);
  });

  test("needsEmail=false ⇒ no email payload even when flat bytes exist (dual-write already projected it)", () => {
    const plan = planContactChannelBackfill(
      row({ emailEnc: encryptPii(EMAIL), emailBlindIndex: blindIndex(EMAIL), emailDomain: "acme.com" }),
      null,
    );
    expect(plan.email).toBeUndefined();
    expect(plan.emailSkipped).toBe(false);
  });

  test("incomplete flat bytes (missing domain) ⇒ emailSkipped, nothing written — stays in the completeness count", () => {
    const plan = planContactChannelBackfill(
      row({ needsEmail: true, emailEnc: encryptPii(EMAIL), emailBlindIndex: blindIndex(EMAIL) }),
      null,
    );
    expect(plan.email).toBeUndefined();
    expect(plan.emailSkipped).toBe(true);
  });
});

describe("planContactChannelBackfill — phone leg (decrypt→toE164 in-worker; raw kept when unparseable)", () => {
  test("parseable with an ISO-2 locationCountry hint ⇒ e164 material derived; value_enc stays flat-verbatim", () => {
    const phoneEnc = encryptPii(PHONE);
    const plan = planContactChannelBackfill(
      row({ needsPhone: true, phoneEnc, locationCountry: "US", phoneStatus: "direct" }),
      PHONE,
    );
    expect(plan.phone).toBeDefined();
    expect(plan.phone?.valueEnc).toBe(phoneEnc); // VERBATIM — the flat ciphertext IS the child value_enc
    expect(plan.phone?.e164Enc).not.toBeNull();
    expect(decryptPii(plan.phone!.e164Enc!)).toBe("+14155552671");
    // Match signals ride the NORMALIZED key: blindIndex(e164), deterministic.
    expect(Buffer.from(plan.phone!.e164BlindIndex!)).toEqual(Buffer.from(blindIndex("+14155552671")));
    expect(plan.phone?.countryHint).toBe("US");
    expect(plan.phone?.status).toBe("direct");
    expect(plan.phoneUnparseable).toBe(false);
  });

  test("national format with a free-text country ⇒ NO hint guessed, kept raw + flagged, NEVER skipped (05 §4)", () => {
    const phoneEnc = encryptPii("555 0100");
    const plan = planContactChannelBackfill(
      row({ needsPhone: true, phoneEnc, locationCountry: "United States" }),
      "555 0100",
    );
    expect(plan.phone).toBeDefined(); // the value IS written — unparseable is a flag, not a rejection
    expect(plan.phone?.valueEnc).toBe(phoneEnc);
    expect(plan.phone?.e164Enc).toBeNull();
    expect(plan.phone?.e164BlindIndex).toBeNull();
    expect(plan.phone?.countryHint).toBeNull();
    expect(plan.phoneUnparseable).toBe(true);
    expect(plan.phoneSkipped).toBe(false);
  });

  test("decrypt failure (plaintext null) ⇒ phoneSkipped — the contact stays in the completeness count, loud", () => {
    const plan = planContactChannelBackfill(
      row({ needsPhone: true, phoneEnc: encryptPii(PHONE) }),
      null,
    );
    expect(plan.phone).toBeUndefined();
    expect(plan.phoneSkipped).toBe(true);
  });

  test("status/line_type mirror flat-wins; the mirrored line_type is attributed carrier_lookup (S-CH2's rule)", () => {
    const plan = planContactChannelBackfill(
      row({
        needsPhone: true,
        phoneEnc: encryptPii(PHONE),
        locationCountry: "US",
        phoneStatus: "mobile",
        phoneLineType: "mobile",
      }),
      PHONE,
    );
    expect(plan.phone?.lineType).toBe("mobile");
    expect(plan.phone?.lineTypeSource).toBe("carrier_lookup");
    expect(plan.gradesSanitized).toBe(false);
  });

  test("legacy out-of-vocabulary grades are sanitized (05 §Edge): line_type → 'unknown', status → NULL", () => {
    const plan = planContactChannelBackfill(
      row({
        needsPhone: true,
        phoneEnc: encryptPii(PHONE),
        phoneStatus: "totally-bogus",
        phoneLineType: "cordless",
      }),
      PHONE,
    );
    expect(plan.phone?.status).toBeNull();
    expect(plan.phone?.lineType).toBe("unknown");
    expect(plan.phone?.lineTypeSource).toBe("carrier_lookup");
    expect(plan.gradesSanitized).toBe(true);
  });

  test("no flat line_type ⇒ NULL line_type AND NULL line_type_source (the mandatory companion never dangles)", () => {
    const plan = planContactChannelBackfill(
      row({ needsPhone: true, phoneEnc: encryptPii(PHONE) }),
      PHONE,
    );
    expect(plan.phone?.lineType).toBeNull();
    expect(plan.phone?.lineTypeSource).toBeNull();
  });
});

describe("planContactChannelBackfill — the per-contact pair", () => {
  test("both channels missing ⇒ both payloads in ONE plan (they ride the same batch tx — all-or-nothing)", () => {
    const emailEnc = encryptPii(EMAIL);
    const phoneEnc = encryptPii(PHONE);
    const plan = planContactChannelBackfill(
      row({
        needsEmail: true,
        emailEnc,
        emailBlindIndex: blindIndex(EMAIL),
        emailDomain: "acme.com",
        needsPhone: true,
        phoneEnc,
        locationCountry: "US",
      }),
      PHONE,
    );
    expect(plan.email?.valueEnc).toBe(emailEnc);
    expect(plan.phone?.valueEnc).toBe(phoneEnc);
  });

  test("nothing needed ⇒ empty plan (the WHERE-missing selection should never produce this, but it is inert)", () => {
    const plan = planContactChannelBackfill(row(), null);
    expect(plan.email).toBeUndefined();
    expect(plan.phone).toBeUndefined();
    expect(plan.emailSkipped).toBe(false);
    expect(plan.phoneSkipped).toBe(false);
  });
});
