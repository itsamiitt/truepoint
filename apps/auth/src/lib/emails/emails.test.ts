// emails.test.ts — guards the transactional auth-email templates (bug6, T-758aca54). Each template must
// render a branded HTML part AND a plaintext fallback, carry the TruePoint brand (never "LeadWolf"), include
// its code/link, and ship the compliance footer (postal address). Pure unit test — no transport.
import { describe, expect, it } from "bun:test";
import {
  type MfaChangeKind,
  magicLinkEmail,
  mfaChangedEmail,
  newSignInEmail,
  passkeyChangedEmail,
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

  it("mfa changed: each kind is brand-correct, distinct, and carries the secure CTA", () => {
    const secureUrl = "https://auth.example.com/auth/forgot";
    const kinds: MfaChangeKind[] = ["enrolled", "disabled", "recovery_regenerated"];
    const subjects = new Set<string>();
    for (const change of kinds) {
      const m = mfaChangedEmail({ change, secureUrl });
      subjects.add(m.subject);
      expect(m.subject).toContain("TruePoint");
      expect(m.html).toContain(secureUrl);
      expect(m.html).not.toContain("LeadWolf");
      expect(m.text).toContain(secureUrl);
      expect(m.html).toContain("San Francisco"); // compliance footer
    }
    expect(subjects.size).toBe(3); // the three kinds are distinguishable
    expect(mfaChangedEmail({ change: "recovery_regenerated" }).html).toContain("no longer work");
  });

  it("new sign-in: carries device + IP context, secure CTA, and escapes the device string", () => {
    const secureUrl = "https://auth.example.com/auth/forgot";
    const m = newSignInEmail({ device: "Chrome on macOS", ipAddress: "203.0.113.7", secureUrl });
    expect(m.subject).toBe("New sign-in to your TruePoint account");
    expect(m.html).toContain("Chrome on macOS");
    expect(m.html).toContain("IP 203.0.113.7");
    expect(m.html).toContain(secureUrl);
    expect(m.html).not.toContain("LeadWolf");
    expect(m.text).toContain("203.0.113.7");
    expect(m.text).toContain("San Francisco"); // footer
    // a user-agent-derived device string is attacker-influenced → must be HTML-escaped
    const evil = newSignInEmail({ device: "<script>x</script>" });
    expect(evil.html).not.toContain("<script>x</script>");
    expect(evil.html).toContain("&lt;script&gt;");
  });

  it("new sign-in: no context renders cleanly (no 'undefined', no dangling separator)", () => {
    const m = newSignInEmail();
    expect(m.html.startsWith("<!doctype html>")).toBe(true);
    expect(m.html).not.toContain("undefined");
    expect(m.html).not.toContain(" — .");
    expect(m.text).not.toContain("undefined");
  });

  it("every template renders an html document and a non-empty plaintext fallback", () => {
    for (const m of [
      verificationCodeEmail({ code: "000000" }),
      magicLinkEmail({ link: "https://x.test/m" }),
      passwordResetEmail({ link: "https://x.test/r" }),
      passwordChangedEmail({ secureUrl: "https://x.test/forgot" }),
      mfaChangedEmail({ change: "enrolled", secureUrl: "https://x.test/forgot" }),
      passkeyChangedEmail({ change: "added", secureUrl: "https://x.test/forgot" }),
      passkeyChangedEmail({ change: "removed" }),
      newSignInEmail({ device: "Firefox on Windows", ipAddress: "198.51.100.2" }),
    ]) {
      expect(m.html.startsWith("<!doctype html>")).toBe(true);
      expect(m.text.length).toBeGreaterThan(0);
    }
  });
});
