// mailTransport.test.ts — guards AUTH-061. A production SMTP transport pointed at a dev mail-capture tool
// (MailHog et al.) or a loopback never delivers to a real inbox; the classifier must recognize them so the
// mailer can flag the misconfiguration loudly. A real ESP host must classify as NOT dev-capture.
import { describe, expect, it } from "bun:test";
import { devCaptureHost, isDevCaptureTransport } from "./mailTransport.ts";

describe("mailTransport", () => {
  it("flags MailHog (the shipped prod default) as dev-capture", () => {
    expect(isDevCaptureTransport("smtp://mailhog:1025")).toBe(true);
    expect(devCaptureHost("smtp://mailhog:1025")).toBe("mailhog");
  });

  it("flags other dev-capture / loopback hosts", () => {
    for (const url of [
      "smtp://mailpit:1025",
      "smtp://maildev:1025",
      "smtp://localhost:2525",
      "smtp://127.0.0.1:25",
      "smtp://user:pass@[::1]:465",
    ]) {
      expect(isDevCaptureTransport(url)).toBe(true);
    }
  });

  it("does NOT flag a real ESP transport", () => {
    for (const url of [
      "smtps://apikey:SG.xxx@smtp.sendgrid.net:465",
      "smtp://resend:re_xxx@smtp.resend.com:587",
      "smtps://user:pass@email-smtp.ap-south-1.amazonaws.com:465",
    ]) {
      expect(isDevCaptureTransport(url)).toBe(false);
      expect(devCaptureHost(url)).toBeNull();
    }
  });

  it("returns null (does not throw) for an unparseable URL", () => {
    expect(devCaptureHost("not a url")).toBeNull();
    expect(isDevCaptureTransport("")).toBe(false);
  });
});
