// identifierLookup.test.ts — proves Step-1 progressive-login routing (ADR-0020) AND that the canonical email
// is always carried forward, which is the value the /password and /magic screens render (so bug 1's prefill
// has something to read). @leadwolf/db is module-mocked so this stays a pure unit test (no DB / no env — the
// real db client opens a postgres pool at import). The domain resolver is injected, per the function's design.
import { describe, expect, it, mock } from "bun:test";

type FakeUser = { email: string; passwordHash: string | null };

const findByEmailOrUsername = mock(async (_id: string): Promise<FakeUser | null> => null);
mock.module("@leadwolf/db", () => ({ userRepository: { findByEmailOrUsername } }));

const { lookupIdentifier } = await import("./identifierLookup.ts");

/** Resolver for an unclaimed domain (no SSO routing). */
const noDomain = async () => null;

describe("lookupIdentifier step routing", () => {
  it("existing user WITH a password → route 'password', carrying the canonical email", async () => {
    findByEmailOrUsername.mockResolvedValueOnce({
      email: "ada@x.test",
      passwordHash: "$argon2id$x",
    });
    const r = await lookupIdentifier("ada@x.test", noDomain);
    expect(r.route).toBe("password");
    expect(r.email).toBe("ada@x.test");
  });

  it("existing user WITHOUT a password → route 'magic', carrying the email", async () => {
    findByEmailOrUsername.mockResolvedValueOnce({ email: "grace@x.test", passwordHash: null });
    const r = await lookupIdentifier("grace@x.test", noDomain);
    expect(r.route).toBe("magic");
    expect(r.email).toBe("grace@x.test");
  });

  it("username login resolves to the account's email and carries THAT, not the username", async () => {
    findByEmailOrUsername.mockResolvedValueOnce({
      email: "linus@x.test",
      passwordHash: "$argon2id$x",
    });
    const r = await lookupIdentifier("linus", noDomain);
    expect(r.route).toBe("password");
    expect(r.email).toBe("linus@x.test");
  });

  it("unknown identity → route 'register', carrying the email when it was one", async () => {
    findByEmailOrUsername.mockResolvedValueOnce(null);
    const r = await lookupIdentifier("new@x.test", noDomain);
    expect(r.route).toBe("register");
    expect(r.email).toBe("new@x.test");
  });

  it("SSO-enforced domain wins (before unknown→register) for first-time users", async () => {
    findByEmailOrUsername.mockResolvedValueOnce(null);
    const ssoDomain = async () => ({
      tenantId: "00000000-0000-0000-0000-000000000001",
      tenantName: "Acme",
      joinPolicy: "sso_only",
      ssoEnforced: true,
      ssoProtocol: "oidc",
    });
    const r = await lookupIdentifier("dev@acme.test", ssoDomain);
    expect(r.route).toBe("sso");
    expect(r.email).toBe("dev@acme.test");
  });
});
