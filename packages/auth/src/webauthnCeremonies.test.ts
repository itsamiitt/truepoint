// webauthnCeremonies.test.ts — the SECURITY orchestration around BOTH passkey ceremonies (AUTH-024). The crypto
// is the vetted @simplewebauthn/server; what these prove is OUR logic around it. Registration and authentication
// live in ONE file because bun's mock.module is process-global — mocking @simplewebauthn/server from two files
// makes the last-registered mock (missing the other file's export) leak across. So we mock each module ONCE here,
// with the union of the methods both ceremonies use, driven by shared per-test state. No DB/Redis/authenticator.

import { describe, expect, it, mock } from "bun:test";
import { __resetAuthMetrics, renderAuthMetrics } from "./authMetrics.ts";

// ── shared mock state (each test sets what it needs) ────────────────────────────────────────────────────────
interface CreateInput {
  userId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  backedUp?: boolean;
  label?: string;
}
type Cred = {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | null;
};

let challenge: string | null = "chal";
let throwOnVerify = false;
let regResult: {
  verified: boolean;
  registrationInfo?: {
    credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] };
    aaguid: string;
    credentialBackedUp: boolean;
  };
} = { verified: false };
let authResult: { verified: boolean; authenticationInfo?: { newCounter: number } } = {
  verified: false,
};
let cred: Cred | null = null;
const creates: CreateInput[] = [];
const counterUpdates: Array<{ credentialId: string; counter: number }> = [];

mock.module("./webauthnChallenge.ts", () => ({
  consumeWebauthnChallenge: async () => challenge,
  storeWebauthnChallenge: async () => {},
}));
mock.module("@leadwolf/db", () => ({
  webauthnCredentialRepository: {
    create: async (input: CreateInput) => {
      creates.push(input);
    },
    findByCredentialId: async () => cred,
    updateCounter: async (credentialId: string, counter: number) => {
      counterUpdates.push({ credentialId, counter });
    },
    listForUser: async () => [],
  },
}));
mock.module("@simplewebauthn/server", () => ({
  verifyRegistrationResponse: async () => {
    if (throwOnVerify) throw new Error("bad attestation");
    return regResult;
  },
  verifyAuthenticationResponse: async () => {
    if (throwOnVerify) throw new Error("bad assertion");
    return authResult;
  },
  generateRegistrationOptions: async () => ({ challenge: "x" }),
  generateAuthenticationOptions: async () => ({ challenge: "x" }),
}));

const { verifyPasskeyRegistration } = await import("./webauthnRegistration.ts");
const { verifyPasskeyAuthentication } = await import("./webauthnAuthentication.ts");
type RegResp = Parameters<typeof verifyPasskeyRegistration>[1];
type AuthResp = Parameters<typeof verifyPasskeyAuthentication>[1];
const REG_RESP = {} as unknown as RegResp;
const AUTH_RESP = { id: "cred-1" } as unknown as AuthResp;

const ownCred: Cred = {
  id: "x",
  userId: "u1",
  credentialId: "cred-1",
  publicKey: new Uint8Array([1]),
  counter: 0,
  transports: null,
};

describe("verifyPasskeyRegistration — security orchestration", () => {
  it("fails closed when there is no pending challenge", async () => {
    challenge = null;
    creates.length = 0;
    expect(await verifyPasskeyRegistration({ id: "u1" }, REG_RESP)).toBe(false);
    expect(creates).toEqual([]);
  });

  it("fails and does NOT persist when the library throws on the attestation", async () => {
    challenge = "chal";
    throwOnVerify = true;
    creates.length = 0;
    expect(await verifyPasskeyRegistration({ id: "u1" }, REG_RESP)).toBe(false);
    expect(creates).toEqual([]);
    throwOnVerify = false;
  });

  it("fails and does NOT persist when the library rejects the attestation", async () => {
    challenge = "chal";
    regResult = { verified: false };
    creates.length = 0;
    expect(await verifyPasskeyRegistration({ id: "u1" }, REG_RESP)).toBe(false);
    expect(creates).toEqual([]);
  });

  it("fails when verified but registrationInfo is absent", async () => {
    challenge = "chal";
    regResult = { verified: true };
    creates.length = 0;
    expect(await verifyPasskeyRegistration({ id: "u1" }, REG_RESP)).toBe(false);
    expect(creates).toEqual([]);
  });

  it("persists the credential for the user on a clean verification", async () => {
    challenge = "chal";
    regResult = {
      verified: true,
      registrationInfo: {
        credential: {
          id: "cred-1",
          publicKey: new Uint8Array([1, 2]),
          counter: 0,
          transports: ["internal"],
        },
        aaguid: "aaguid-1",
        credentialBackedUp: true,
      },
    };
    creates.length = 0;
    expect(await verifyPasskeyRegistration({ id: "u1" }, REG_RESP, "My Phone")).toBe(true);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      userId: "u1",
      credentialId: "cred-1",
      counter: 0,
      backedUp: true,
      label: "My Phone",
    });
  });
});

describe("verifyPasskeyAuthentication — security orchestration", () => {
  it("fails closed when there is no pending challenge", async () => {
    challenge = null;
    cred = ownCred;
    expect(await verifyPasskeyAuthentication("u1", AUTH_RESP)).toBe(false);
  });

  it("fails when the presented credential is not found", async () => {
    challenge = "chal";
    cred = null;
    expect(await verifyPasskeyAuthentication("u1", AUTH_RESP)).toBe(false);
  });

  it("REFUSES a credential that belongs to another user (no cross-user assertion)", async () => {
    challenge = "chal";
    cred = { ...ownCred, userId: "OTHER" };
    expect(await verifyPasskeyAuthentication("u1", AUTH_RESP)).toBe(false);
  });

  it("fails and does NOT advance the counter when the library rejects the assertion", async () => {
    challenge = "chal";
    cred = ownCred;
    authResult = { verified: false };
    counterUpdates.length = 0;
    expect(await verifyPasskeyAuthentication("u1", AUTH_RESP)).toBe(false);
    expect(counterUpdates).toEqual([]);
  });

  it("verifies and advances the signature counter on success", async () => {
    challenge = "chal";
    cred = ownCred;
    authResult = { verified: true, authenticationInfo: { newCounter: 7 } };
    counterUpdates.length = 0;
    expect(await verifyPasskeyAuthentication("u1", AUTH_RESP)).toBe(true);
    expect(counterUpdates).toEqual([{ credentialId: "cred-1", counter: 7 }]);
  });
});

describe("webauthn_ceremony_total metric", () => {
  it("records ceremony + result labels on each outcome (bounded cardinality)", async () => {
    __resetAuthMetrics();
    // one register success
    challenge = "chal";
    regResult = {
      verified: true,
      registrationInfo: {
        credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0 },
        aaguid: "a",
        credentialBackedUp: false,
      },
    };
    await verifyPasskeyRegistration({ id: "u1" }, REG_RESP);
    // one authenticate failure (no pending challenge)
    challenge = null;
    await verifyPasskeyAuthentication("u1", AUTH_RESP);

    const out = renderAuthMetrics();
    expect(out).toContain('webauthn_ceremony_total{ceremony="register",result="success"} 1');
    expect(out).toContain('webauthn_ceremony_total{ceremony="authenticate",result="failure"} 1');
  });
});
