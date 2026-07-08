// webauthnAuthentication.test.ts — the SECURITY orchestration around the passkey assertion (AUTH-024). The
// signature crypto is the vetted @simplewebauthn/server (mocked here); what this proves is OUR logic: fail
// closed with no pending challenge or an unknown credential, REFUSE a credential that belongs to another user
// (no cross-user assertion), and advance the signature counter ONLY on a verified assertion. Repo + challenge
// store + the lib are mocked so the test needs no DB/Redis/authenticator.

import { describe, expect, it, mock } from "bun:test";

let challenge: string | null = "chal";
let cred: {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | null;
} | null = null;
let verifyResult: { verified: boolean; authenticationInfo?: { newCounter: number } } = {
  verified: true,
  authenticationInfo: { newCounter: 5 },
};
const counterUpdates: Array<{ credentialId: string; counter: number }> = [];

mock.module("./webauthnChallenge.ts", () => ({
  consumeWebauthnChallenge: async () => challenge,
  storeWebauthnChallenge: async () => {},
}));
mock.module("@leadwolf/db", () => ({
  webauthnCredentialRepository: {
    findByCredentialId: async () => cred,
    updateCounter: async (credentialId: string, counter: number) => {
      counterUpdates.push({ credentialId, counter });
    },
    listForUser: async () => [],
  },
}));
mock.module("@simplewebauthn/server", () => ({
  verifyAuthenticationResponse: async () => verifyResult,
  generateAuthenticationOptions: async () => ({ challenge: "x" }),
}));

const { verifyPasskeyAuthentication } = await import("./webauthnAuthentication.ts");
type Resp = Parameters<typeof verifyPasskeyAuthentication>[1];
const RESP = { id: "cred-1" } as unknown as Resp;
const ownCred = {
  id: "x",
  userId: "u1",
  credentialId: "cred-1",
  publicKey: new Uint8Array([1]),
  counter: 0,
  transports: null,
};

describe("verifyPasskeyAuthentication — security orchestration", () => {
  it("fails closed when there is no pending challenge", async () => {
    challenge = null;
    cred = ownCred;
    expect(await verifyPasskeyAuthentication("u1", RESP)).toBe(false);
  });

  it("fails when the presented credential is not found", async () => {
    challenge = "chal";
    cred = null;
    expect(await verifyPasskeyAuthentication("u1", RESP)).toBe(false);
  });

  it("REFUSES a credential that belongs to another user (no cross-user assertion)", async () => {
    challenge = "chal";
    cred = { ...ownCred, userId: "OTHER" };
    expect(await verifyPasskeyAuthentication("u1", RESP)).toBe(false);
  });

  it("fails and does NOT advance the counter when the library rejects the assertion", async () => {
    challenge = "chal";
    cred = ownCred;
    verifyResult = { verified: false };
    counterUpdates.length = 0;
    expect(await verifyPasskeyAuthentication("u1", RESP)).toBe(false);
    expect(counterUpdates).toEqual([]);
  });

  it("verifies and advances the signature counter on success", async () => {
    challenge = "chal";
    cred = ownCred;
    verifyResult = { verified: true, authenticationInfo: { newCounter: 7 } };
    counterUpdates.length = 0;
    expect(await verifyPasskeyAuthentication("u1", RESP)).toBe(true);
    expect(counterUpdates).toEqual([{ credentialId: "cred-1", counter: 7 }]);
  });
});
