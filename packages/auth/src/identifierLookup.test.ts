// identifierLookup.test.ts — proves Step-1 progressive-login routing (ADR-0020) AND that the canonical email
// is always carried forward (the value /password and /magic render, so bug 1's prefill has something to read).
// The DB lookup is INJECTED (like resolveDomain), so this is a pure unit test with NO DB and NO module-mock —
// a bun mock.module of @leadwolf/db is global and would leak into the rest of the suite (reviewer-qs F-series).
import { describe, expect, it } from "bun:test";
import { type UserLookup, lookupIdentifier } from "./identifierLookup.ts";

type FakeUser = { email: string; passwordHash: string | null };
const noDomain = async () => null;
/** An injected user-lookup that always resolves to `user`. */
const found = (user: FakeUser | null): UserLookup => async () => user;

describe("lookupIdentifier step routing", () => {
  it("existing user WITH a password → route 'password', carrying the canonical email", async () => {
    const r = await lookupIdentifier(
      "ada@x.test",
      noDomain,
      found({ email: "ada@x.test", passwordHash: "$argon2id$x" }),
    );
    expect(r.route).toBe("password");
    expect(r.email).toBe("ada@x.test");
  });

  it("existing user WITHOUT a password → route 'magic', carrying the email", async () => {
    const r = await lookupIdentifier(
      "grace@x.test",
      noDomain,
      found({ email: "grace@x.test", passwordHash: null }),
    );
    expect(r.route).toBe("magic");
    expect(r.email).toBe("grace@x.test");
  });

  it("username login resolves to the account's email and carries THAT, not the username", async () => {
    const r = await lookupIdentifier(
      "linus",
      noDomain,
      found({ email: "linus@x.test", passwordHash: "$argon2id$x" }),
    );
    expect(r.route).toBe("password");
    expect(r.email).toBe("linus@x.test");
  });

  it("unknown identity → route 'register', carrying the email when it was one", async () => {
    const r = await lookupIdentifier("new@x.test", noDomain, found(null));
    expect(r.route).toBe("register");
    expect(r.email).toBe("new@x.test");
  });

  it("SSO-enforced domain wins (before unknown→register) for first-time users", async () => {
    const ssoDomain = async () => ({
      tenantId: "00000000-0000-0000-0000-000000000001",
      tenantName: "Acme",
      joinPolicy: "sso_only",
      ssoEnforced: true,
      ssoProtocol: "oidc",
    });
    const r = await lookupIdentifier("dev@acme.test", ssoDomain, found(null));
    expect(r.route).toBe("sso");
    expect(r.email).toBe("dev@acme.test");
  });
});
