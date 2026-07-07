// emails.test.ts — guards the transactional auth-email templates (bug6, T-758aca54). Each template must
// render a branded HTML part AND a plaintext fallback, carry the TruePoint brand (never "LeadWolf"), include
// its code/link, and ship the compliance footer (postal address). Pure unit test — no transport.
import { describe, expect, it } from "bun:test";
import {
  magicLinkEmail,
  passwordChangedEmail,
  passwordResetEmail,
  verificationCodeEmail,
} from "./index.ts";

describe("transactional auth email templates", () => {
  it("verification code: html + text carry the code, never say LeadWolf", () => {
    const m = verificationCodeEmail({ code: "123456" });
    expect(m.subject).toBe("Your TruePoint verification code");
    expect(m.html).toContain("123456");
    expect(m.html).toContain("TruePoint");
    expect(m.html).not.toContain("LeadWolf");
    expect(m.text).toContain("123456");
    expect(m.text).not.toContain("LeadWolf");
    // compliance footer present in both parts
    expect(m.html).toContain("San Francisco");
    expect(m.text).toContain("San Francisco");
  });

  it("magic link: html links to the url with a copy-paste fallback", () => {
    const link = "https://auth.example.com/magic/confirm?email=a%40b.com&code=xyz";
    const m = magicLinkEmail({ link });
    expect(m.subject).toBe("Your TruePoint sign-in link");
    expect(m.html).toContain("auth.example.com/magic/confirm");
    expect(m.html).not.toContain("LeadWolf");
    expect(m.text).toContain(link);
  });

  it("password reset: html links to the reset url; subject + brand correct", () => {
    const link = "https://auth.example.com/reset?email=a%40b.com&code=xyz";
    const m = passwordResetEmail({ link });
    expect(m.subject).toBe("Reset your TruePoint password");
    expect(m.html).toContain("auth.example.com/reset");
    expect(m.html).not.toContain("LeadWolf");
    expect(m.text).toContain(link);
  });

  it("password changed: security notification carries the brand + secure CTA, never LeadWolf", () => {
    const secureUrl = "https://auth.example.com/auth/forgot";
    const m = passwordChangedEmail({ secureUrl });
    expect(m.subject).toBe("Your TruePoint password was changed");
    expect(m.html).toContain("was just changed");
    expect(m.html).toContain(secureUrl);
    expect(m.html).toContain("TruePoint");
    expect(m.html).not.toContain("LeadWolf");
    expect(m.text).toContain(secureUrl);
    // compliance footer present in both parts
    expect(m.html).toContain("San Francisco");
    expect(m.text).toContain("San Francisco");
  });

  it("password changed: renders a valid document with no secure link (no CTA)", () => {
    const m = passwordChangedEmail();
    expect(m.html.startsWith("<!doctype html>")).toBe(true);
    expect(m.html).toContain("TruePoint");
    expect(m.html).not.toContain("LeadWolf");
    expect(m.text.length).toBeGreaterThan(0);
  });

  it("every template renders an html document and a non-empty plaintext fallback", () => {
    for (const m of [
      verificationCodeEmail({ code: "000000" }),
      magicLinkEmail({ link: "https://x.test/m" }),
      passwordResetEmail({ link: "https://x.test/r" }),
      passwordChangedEmail({ secureUrl: "https://x.test/forgot" }),
    ]) {
      expect(m.html.startsWith("<!doctype html>")).toBe(true);
      expect(m.text.length).toBeGreaterThan(0);
    }
  });
});
