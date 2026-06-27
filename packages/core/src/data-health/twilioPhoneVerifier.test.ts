// twilioPhoneVerifier.test.ts — the Twilio Lookup response→PhoneStatus mapping, the format-floor degrade, and
// the format-only / static ports. All offline (injected fetch).
import { describe, expect, test } from "bun:test";
import { formatOnlyPhoneVerifier, staticPhoneVerifier } from "./phoneVerifier.ts";
import {
  type PhoneLookupFetch,
  twilioLookupVerifier,
  twilioStatusFrom,
} from "./twilioPhoneVerifier.ts";

const VALID = "+14155552671"; // E.164-valid (validatePhone → "valid")
const fixedFetch =
  (status: number, json: unknown): PhoneLookupFetch =>
  async () => ({ status, json });

describe("twilioStatusFrom", () => {
  test("valid:true → valid", () => expect(twilioStatusFrom({ valid: true })).toBe("valid"));
  test("valid:false → invalid", () => expect(twilioStatusFrom({ valid: false })).toBe("invalid"));
  test("missing valid → null (caller falls back)", () => expect(twilioStatusFrom({})).toBeNull());
  test("null payload → null", () => expect(twilioStatusFrom(null)).toBeNull());
});

describe("twilioLookupVerifier", () => {
  const opts = { accountSid: "AC", authToken: "tok" };
  test("maps a 200 carrier-confirmed valid", async () => {
    const v = twilioLookupVerifier({ ...opts, fetchJson: fixedFetch(200, { valid: true }) });
    expect(await v.verify(VALID, null)).toBe("valid");
  });
  test("maps a 200 carrier-confirmed invalid", async () => {
    const v = twilioLookupVerifier({ ...opts, fetchJson: fixedFetch(200, { valid: false }) });
    expect(await v.verify(VALID, null)).toBe("invalid");
  });
  test("non-2xx degrades to the E.164 format check", async () => {
    const v = twilioLookupVerifier({ ...opts, fetchJson: fixedFetch(404, null) });
    expect(await v.verify(VALID, null)).toBe("valid"); // format floor
    expect(await v.verify("123", null)).toBe("invalid"); // bad format floor
  });
  test("a transport throw degrades to the E.164 format check (never throws)", async () => {
    const v = twilioLookupVerifier({
      ...opts,
      fetchJson: async () => {
        throw new Error("network down");
      },
    });
    expect(await v.verify(VALID, null)).toBe("valid");
  });
  test("GETs the v2 Lookup URL with Basic auth", async () => {
    let calledUrl = "";
    let authHeader = "";
    const fj: PhoneLookupFetch = async (url, init) => {
      calledUrl = url;
      authHeader = init.headers.authorization ?? "";
      return { status: 200, json: { valid: true } };
    };
    const v = twilioLookupVerifier({ ...opts, fetchJson: fj });
    await v.verify(VALID, null);
    expect(calledUrl).toBe("https://lookups.twilio.com/v2/PhoneNumbers/%2B14155552671");
    expect(authHeader).toBe(`Basic ${Buffer.from("AC:tok").toString("base64")}`);
  });
});

describe("formatOnlyPhoneVerifier / staticPhoneVerifier", () => {
  test("format-only wraps validatePhone", async () => {
    expect(await formatOnlyPhoneVerifier.verify(VALID, null)).toBe("valid");
    expect(await formatOnlyPhoneVerifier.verify("nope", null)).toBe("invalid");
  });
  test("static returns the mapped status", async () => {
    const v = staticPhoneVerifier({ [VALID]: "mobile" });
    expect(await v.verify(VALID, null)).toBe("mobile");
    expect(await v.verify("+10000000000", null)).toBe("unknown");
  });
});
