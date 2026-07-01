// detectAutoReply.test.ts — unit tests for the RFC 3834 auto-reply heuristic (M12 P3).

import { describe, expect, test } from "bun:test";
import { detectAutoReply } from "./detectAutoReply.ts";

describe("detectAutoReply", () => {
  test("a plain reply with no automation headers is human", () => {
    expect(detectAutoReply({ subject: "Re: your proposal", from: "jane@acme.com" })).toEqual({
      isAuto: false,
      classification: "human",
    });
  });

  test("Auto-Submitted other than 'no' is automated", () => {
    expect(detectAutoReply({ "auto-submitted": "auto-replied", subject: "Re: hi" })).toMatchObject({
      isAuto: true,
      classification: "auto_reply",
    });
  });

  test("Auto-Submitted 'no' is still a human reply", () => {
    expect(detectAutoReply({ "auto-submitted": "no", subject: "Re: hi" })).toEqual({
      isAuto: false,
      classification: "human",
    });
  });

  test("Auto-Submitted + an OOO subject classifies as ooo", () => {
    expect(
      detectAutoReply({
        "auto-submitted": "auto-replied",
        subject: "Automatic reply: Out of office",
      }),
    ).toEqual({ isAuto: true, classification: "ooo" });
  });

  test("X-Autoreply header is automated", () => {
    expect(detectAutoReply({ "x-autoreply": "yes", subject: "Re: hi" })).toMatchObject({
      isAuto: true,
    });
  });

  test("a bulk Precedence is automated", () => {
    expect(detectAutoReply({ precedence: "bulk", subject: "Re: hi" })).toMatchObject({
      isAuto: true,
      classification: "auto_reply",
    });
  });

  test("an OOO subject alone classifies as ooo", () => {
    expect(detectAutoReply({ subject: "Out of Office: back Monday" })).toEqual({
      isAuto: true,
      classification: "ooo",
    });
  });
});
