// jwks.test.ts — dual-key JWKS publication for overlapping-kid rotation (AUTH-013). Generates two real EdDSA
// keypairs and drives the REAL getJwks with @leadwolf/config spread from the preload-seeded module, overriding
// only the JWT key env per case (a Proxy so a per-test reassignment is read live). Proves: only the active key
// is published by default; BOTH active + next are published during a rotation window; and an incomplete next
// config (kid without PEM) publishes only the active key rather than a malformed entry.

import { describe, expect, it } from "bun:test";
import { mock } from "bun:test";
import * as realConfig from "@leadwolf/config";
import { exportSPKI, generateKeyPair } from "jose";

const a = await generateKeyPair("EdDSA");
const b = await generateKeyPair("EdDSA");
const aPem = await exportSPKI(a.publicKey);
const bPem = await exportSPKI(b.publicKey);

const overrides: Record<string, string> = {
  JWT_SIGNING_KID: "key-a",
  JWT_PUBLIC_KEY_PEM: aPem,
  JWT_NEXT_SIGNING_KID: "",
  JWT_NEXT_PUBLIC_KEY_PEM: "",
};

// The real env is frozen, so a Proxy can't override its EXISTING props (invariant). Instead make a new object
// whose prototype is the real env (non-JWT reads fall through) with live getter props for the keys we vary.
const mockEnv = Object.create(realConfig.env, {
  JWT_SIGNING_KID: { get: () => overrides.JWT_SIGNING_KID, enumerable: true, configurable: true },
  JWT_PUBLIC_KEY_PEM: {
    get: () => overrides.JWT_PUBLIC_KEY_PEM,
    enumerable: true,
    configurable: true,
  },
  JWT_NEXT_SIGNING_KID: {
    get: () => overrides.JWT_NEXT_SIGNING_KID,
    enumerable: true,
    configurable: true,
  },
  JWT_NEXT_PUBLIC_KEY_PEM: {
    get: () => overrides.JWT_NEXT_PUBLIC_KEY_PEM,
    enumerable: true,
    configurable: true,
  },
});
mock.module("@leadwolf/config", () => ({ ...realConfig, env: mockEnv }));

const { getJwks } = await import("./token.ts");

describe("getJwks — overlapping-kid rotation", () => {
  it("publishes ONLY the active key when no next key is configured", async () => {
    overrides.JWT_NEXT_SIGNING_KID = "";
    overrides.JWT_NEXT_PUBLIC_KEY_PEM = "";
    const { keys } = await getJwks();
    expect(keys).toHaveLength(1);
    expect(keys[0]?.kid).toBe("key-a");
    expect(keys[0]?.use).toBe("sig");
    expect(keys[0]?.alg).toBe("EdDSA");
  });

  it("publishes BOTH active + next during a rotation window", async () => {
    overrides.JWT_NEXT_SIGNING_KID = "key-b";
    overrides.JWT_NEXT_PUBLIC_KEY_PEM = bPem;
    const { keys } = await getJwks();
    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.kid as string).sort()).toEqual(["key-a", "key-b"]);
    // both are distinct verification keys (the whole point of the overlap)
    expect(keys[0]?.x).not.toBe(keys[1]?.x);
  });

  it("publishes only the active key if the next kid is set but its PEM is missing", async () => {
    overrides.JWT_NEXT_SIGNING_KID = "key-b";
    overrides.JWT_NEXT_PUBLIC_KEY_PEM = "";
    const { keys } = await getJwks();
    expect(keys).toHaveLength(1);
    expect(keys[0]?.kid).toBe("key-a");
  });
});
