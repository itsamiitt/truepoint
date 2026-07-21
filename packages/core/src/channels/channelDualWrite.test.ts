// channelDualWrite.test.ts — unit tests for the S-CH2 pure pieces (05 §4): the phone blind-index form
// (digit-compact, leading + kept), country-hint resolution (ISO-2 only, never guessed from free text), and
// the E.164 pipeline through buildPhoneChannelValue (determinism of blindIndex(toE164(...)); unparseable ⇒
// raw kept, e164 material NULL; hint recorded as used). The test preload (test/setup.ts) seeds
// BLIND_INDEX_KEY, so the DM1 primitives run for real — no DB.

import { describe, expect, test } from "bun:test";
import { blindIndex } from "../import/blindIndex.ts";
import { decryptPii, encryptPii } from "../import/encryptPii.ts";
import { buildPhoneChannelValue, countryHintOf, phoneRawIndexForm } from "./channelDualWrite.ts";

describe("phoneRawIndexForm — the 05 §1.1 digit-compacted raw key", () => {
  test("strips [\\s().-] and keeps a leading +", () => {
    expect(phoneRawIndexForm("+1 (415) 555-2671")).toBe("+14155552671");
    expect(phoneRawIndexForm("415.555.2671")).toBe("4155552671");
    expect(phoneRawIndexForm("0141 555 2671")).toBe("01415552671");
  });

  test("same value typed differently still differs on the RAW key (E.164 is the match key, not this)", () => {
    // 05 §Edge cases: raw keys differ; the e164 blind index is what collapses them.
    expect(phoneRawIndexForm("+1 (415) 555-2671")).not.toBe(phoneRawIndexForm("14155552671"));
  });
});

describe("countryHintOf — S-CH2 slice of the 05 §4.2 resolution order", () => {
  test("accepts an ISO-3166 alpha-2 code, case-insensitively", () => {
    expect(countryHintOf("us")).toBe("US");
    expect(countryHintOf(" GB ")).toBe("GB");
  });
  test("never guesses from free-text country names or absence", () => {
    expect(countryHintOf("United States")).toBeUndefined();
    expect(countryHintOf("")).toBeUndefined();
    expect(countryHintOf(null)).toBeUndefined();
    expect(countryHintOf(undefined)).toBeUndefined();
    expect(countryHintOf("U1")).toBeUndefined();
  });
});

describe("buildPhoneChannelValue — the 05 §4 write-time pipeline (DM1: shipped toE164, no second parser)", () => {
  const phoneEnc = encryptPii("+1 (415) 555-2671");

  test("parseable: dual representation — value bytes passed through verbatim + derived E.164 material", () => {
    const built = buildPhoneChannelValue({ cleaned: "+1 (415) 555-2671", phoneEnc });
    expect(built.valueEnc).toBe(phoneEnc); // the EXACT flat ciphertext bytes (CH-INV-1 byte identity)
    expect(built.blindIndex).toEqual(blindIndex("+14155552671")); // digit-compacted raw key
    expect(built.e164BlindIndex).toEqual(blindIndex("+14155552671")); // canonical E.164 key
    expect(built.e164Enc).not.toBeNull();
    expect(decryptPii(built.e164Enc!)).toBe("+14155552671");
  });

  test("determinism: blindIndex(toE164(...)) is stable across calls + input formatting (the dedup key)", () => {
    const a = buildPhoneChannelValue({ cleaned: "+1 (415) 555-2671", phoneEnc });
    const b = buildPhoneChannelValue({ cleaned: "1-415-555-2671", phoneEnc, countryHint: "US" });
    expect(a.e164BlindIndex).toEqual(b.e164BlindIndex); // same person, two typists — one E.164 key
    expect(a.blindIndex).not.toEqual(b.blindIndex); // raw keys legitimately differ
  });

  test("national format resolves only WITH a hint; the hint used is recorded", () => {
    const withHint = buildPhoneChannelValue({
      cleaned: "(415) 555-2671",
      phoneEnc,
      countryHint: "US",
    });
    expect(withHint.e164Enc).not.toBeNull();
    expect(withHint.countryHint).toBe("US");

    const withoutHint = buildPhoneChannelValue({ cleaned: "(415) 555-2671", phoneEnc });
    expect(withoutHint.e164Enc).toBeNull();
    expect(withoutHint.countryHint).toBeNull();
  });

  test("unparseable: kept raw + flagged (NULL e164 material), never a throw (05 §4.3)", () => {
    const built = buildPhoneChannelValue({ cleaned: "ext. 12", phoneEnc });
    expect(built.valueEnc).toBe(phoneEnc);
    expect(built.e164Enc).toBeNull();
    expect(built.e164BlindIndex).toBeNull();
    expect(built.blindIndex).toEqual(blindIndex("ext12")); // still exact-match dedupable per contact
  });
});
