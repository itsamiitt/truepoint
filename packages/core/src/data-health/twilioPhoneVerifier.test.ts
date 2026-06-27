// twilioPhoneVerifier.test.ts — the Twilio Lookup status + line-type mapping, the format-floor degrade, and the
// format-only / static ports. All offline (injected fetch).
import { describe, expect, test } from "bun:test";
import { formatOnlyPhoneVerifier, staticPhoneVerifier } from "./phoneVerifier.ts";
import {
  type PhoneLookupFetch,
  twilioLineTypeFrom,
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
  test("missing valid → null", () => expect(twilioStatusFrom({})).toBeNull());
  test("null payload → null", () => expect(twilioStatusFrom(null)).toBeNull());
});

describe("twilioLineTypeFrom", () => {
  const lt = (type: string) => twilioLineTypeFrom({ line_type_intelligence: { type } });
  test("mobile → mobile", () => expect(lt("mobile")).toBe("mobile"));
  test("landline → landline", () => expect(lt("landline")).toBe("landline"));
  test("fixedVoip / nonFixedVoip → voip", () => {
    expect(lt("fixedVoip")).toBe("voip");
    expect(lt("nonFixedVoip")).toBe("voip");
  });
  test("tollFree / other → unknown", () => expect(lt("tollFree")).toBe("unknown"));
  test("absent line_type_intelligence → null", () => {
    expect(twilioLineTypeFrom({ valid: true })).toBeNull();
    expect(twilioLineTypeFrom(null)).toBeNull();
  });
});

describe("twilioLookupVerifier", () => {
  const opts = { accountSid: "AC", authToken: "tok" };
  test("200 valid + mobile → {valid, mobile}", async () => {
    const v = twilioLookupVerifier({
      ...opts,
      fetchJson: fixedFetch(200, { valid: true, line_type_intelligence: { type: "mobile" } }),
    });
    expect(await v.verify(VALID, null)).toEqual({ status: "valid", lineType: "mobile" });
  });
  test("200 invalid → {invalid, null} (no line type for an invalid number)", async () => {
    const v = twilioLookupVerifier({
      ...opts,
      fetchJson: fixedFetch(200, { valid: false, line_type_intelligence: { type: "mobile" } }),
    });
    expect(await v.verify(VALID, null)).toEqual({ status: "invalid", lineType: null });
  });
  test("non-2xx degrades to the E.164 format check, no line type", async () => {
    const v = twilioLookupVerifier({ ...opts, fetchJson: fixedFetch(404, null) });
    expect(await v.verify(VALID, null)).toEqual({ status: "valid", lineType: null });
    expect(await v.verify("123", null)).toEqual({ status: "invalid", lineType: null });
  });
  test("a transport throw degrades to the format check (never throws)", async () => {
    const v = twilioLookupVerifier({
      ...opts,
      fetchJson: async () => {
        throw new Error("network down");
      },
    });
    expect(await v.verify(VALID, null)).toEqual({ status: "valid", lineType: null });
  });
  test("GETs the v2 Lookup URL (with line_type_intelligence) + Basic auth", async () => {
    let calledUrl = "";
    let authHeader = "";
    const fj: PhoneLookupFetch = async (url, init) => {
      calledUrl = url;
      authHeader = init.headers.authorization ?? "";
      return { status: 200, json: { valid: true, line_type_intelligence: { type: "landline" } } };
    };
    const v = twilioLookupVerifier({ ...opts, fetchJson: fj });
    expect(await v.verify(VALID, null)).toEqual({ status: "valid", lineType: "landline" });
    expect(calledUrl).toBe(
      "https://lookups.twilio.com/v2/PhoneNumbers/%2B14155552671?Fields=line_type_intelligence",
    );
    expect(authHeader).toBe(`Basic ${Buffer.from("AC:tok").toString("base64")}`);
  });
});

describe("formatOnlyPhoneVerifier / staticPhoneVerifier", () => {
  test("format-only wraps validatePhone, no line type", async () => {
    expect(await formatOnlyPhoneVerifier.verify(VALID, null)).toEqual({
      status: "valid",
      lineType: null,
    });
    expect(await formatOnlyPhoneVerifier.verify("nope", null)).toEqual({
      status: "invalid",
      lineType: null,
    });
  });
  test("static returns the mapped status, no line type", async () => {
    const v = staticPhoneVerifier({ [VALID]: "mobile" });
    expect(await v.verify(VALID, null)).toEqual({ status: "mobile", lineType: null });
    expect(await v.verify("+10000000000", null)).toEqual({ status: "unknown", lineType: null });
  });
});
