// crmSecretStore.test.ts — the CRM credential envelope (crm-sync 00 §5.3 / §7.2). Pure crypto, no IO.
// Covers the round-trip, the bundle round-trip, that the envelope is AUTHENTICATED (a flipped byte anywhere
// fails rather than yielding garbage), the version-byte rejection that makes a future KMS v2 additive, that
// two encryptions of the same plaintext differ (a fresh IV per call — a fixed IV would leak equality between
// two connections holding the same token), and that no ciphertext contains the plaintext.

import { describe, expect, test } from "bun:test";
import {
  decryptCrmSecret,
  decryptCrmTokenBundle,
  encryptCrmSecret,
  encryptCrmTokenBundle,
} from "./crmSecretStore.ts";
import type { CrmTokenBundle } from "./port.ts";

const BUNDLE: CrmTokenBundle = {
  accessToken: "00D5g000004ABCD!AQwAQF_sample_access",
  refreshToken: "5Aep861_sample_refresh",
  expiresAt: 1_800_000_000_000,
  scopes: ["api", "refresh_token", "offline_access"],
  instanceUrl: "https://acme.my.salesforce.com",
  externalAccountId: "00D5g000004ABCD",
  environment: "production",
};

describe("crmSecretStore", () => {
  test("round-trips a credential string", () => {
    const blob = encryptCrmSecret("super-secret-token");
    expect(decryptCrmSecret(blob)).toBe("super-secret-token");
  });

  test("round-trips a whole token bundle", () => {
    const restored = decryptCrmTokenBundle(encryptCrmTokenBundle(BUNDLE));
    expect(restored).toEqual(BUNDLE);
  });

  test("emits the documented envelope layout: version(1) | iv(12) | tag(16) | ciphertext", () => {
    const blob = encryptCrmSecret("x");
    expect(blob[0]).toBe(0x01);
    // 1 + 12 + 16 = 29 bytes of envelope before any ciphertext, and "x" is one byte under GCM (a stream
    // cipher — no padding), so the total is exactly 30. This pins the layout the decrypt offsets assume.
    expect(blob.length).toBe(30);
  });

  test("a fresh IV per call — the same plaintext never produces the same ciphertext", () => {
    const a = Buffer.from(encryptCrmSecret("identical")).toString("hex");
    const b = Buffer.from(encryptCrmSecret("identical")).toString("hex");
    expect(a).not.toBe(b);
  });

  test("the ciphertext never contains the plaintext", () => {
    const blob = Buffer.from(encryptCrmTokenBundle(BUNDLE));
    expect(blob.toString("utf8")).not.toContain(BUNDLE.accessToken);
    expect(blob.toString("utf8")).not.toContain("refresh");
    expect(blob.toString("utf8")).not.toContain("salesforce.com");
  });

  test("GCM authenticates: flipping any byte of the ciphertext throws", () => {
    const blob = Buffer.from(encryptCrmSecret("tamper-me-please"));
    // Last byte is ciphertext (offsets 0=version, 1..12=iv, 13..28=tag).
    const last = blob.length - 1;
    blob[last] = (blob[last] as number) ^ 0xff;
    expect(() => decryptCrmSecret(blob)).toThrow();
  });

  test("GCM authenticates: flipping a byte of the auth TAG throws", () => {
    const blob = Buffer.from(encryptCrmSecret("tamper-the-tag"));
    blob[13] = (blob[13] as number) ^ 0xff;
    expect(() => decryptCrmSecret(blob)).toThrow();
  });

  test("GCM authenticates: flipping a byte of the IV throws", () => {
    const blob = Buffer.from(encryptCrmSecret("tamper-the-iv"));
    blob[1] = (blob[1] as number) ^ 0xff;
    expect(() => decryptCrmSecret(blob)).toThrow();
  });

  test("an unknown envelope version is rejected by name, not decrypted as v1", () => {
    const blob = Buffer.from(encryptCrmSecret("v2-from-the-future"));
    blob[0] = 0x02;
    expect(() => decryptCrmSecret(blob)).toThrow(/unsupported envelope version 2/);
  });

  test("round-trips a bundle with NO refresh token (SFDC JWT-bearer / HubSpot private app)", () => {
    // port.ts documents refreshToken as absent for these two grant types. JSON.stringify DROPS an undefined
    // property, so the decrypted object must be compared on what it actually contains rather than assumed
    // to carry an explicit `refreshToken: undefined` back.
    const noRefresh: CrmTokenBundle = {
      accessToken: "pat-abc",
      expiresAt: 0, // 0 = non-expiring static token, per port.ts
      scopes: ["crm.objects.contacts.read"],
      environment: "production",
    };
    const restored = decryptCrmTokenBundle(encryptCrmTokenBundle(noRefresh));
    expect(restored.accessToken).toBe("pat-abc");
    expect(restored.expiresAt).toBe(0);
    expect(restored.refreshToken).toBeUndefined();
  });

  test("round-trips a bundle containing non-ASCII (a CRM org name is not guaranteed ASCII)", () => {
    const bundle: CrmTokenBundle = { ...BUNDLE, externalAccountId: "Ünïcøde-Org-日本" };
    // The envelope encrypts utf8 bytes and decodes as utf8; a latin1 slip here would corrupt the account id
    // silently, and the account id is what the workspace/provider/account unique index keys on.
    expect(decryptCrmTokenBundle(encryptCrmTokenBundle(bundle)).externalAccountId).toBe(
      "Ünïcøde-Org-日本",
    );
  });
});
