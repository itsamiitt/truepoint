// policy.test.ts — the strictest-wins effective-policy resolution (ADR-0018 + Phase 1 platform→org→workspace
// engine, doc 11 §3). Pure logic, no DB. Guards the security-critical property: a child scope can only ever
// TIGHTEN a parent — never loosen it — and a malformed stored row degrades to "not set" instead of breaking login.
import { describe, expect, it } from "bun:test";
import type { AuthPolicy } from "@leadwolf/types";
import {
  type AuthPolicyRow,
  assembleScopePolicy,
  composeEffectivePolicy,
  isMethodAllowed,
  resolveEffectivePolicy,
  resolvePolicyFromRows,
  strictestMfa,
} from "./policy.ts";

const base: AuthPolicy = {
  mfaEnforcement: "off",
  allowedMethods: ["password", "oauth", "magic_link", "sso", "passkey"],
  disableSocial: false,
  requireSso: false,
  ipAllowlist: [],
};

describe("strictestMfa", () => {
  it("escalates to the strictest level, ignoring undefined", () => {
    expect(strictestMfa("off", "optional", "required")).toBe("required");
    expect(strictestMfa("optional", undefined, "off")).toBe("optional");
    expect(strictestMfa(undefined, undefined)).toBe("off");
  });
});

describe("resolveEffectivePolicy (two-scope)", () => {
  it("a child can tighten but NOT loosen mfa / timeouts", () => {
    const eff = resolveEffectivePolicy(
      { ...base, mfaEnforcement: "required", sessionTimeoutSeconds: 3600 },
      { mfaEnforcement: "off", sessionTimeoutSeconds: 7200 }, // tries to loosen both
    );
    expect(eff.mfaEnforcement).toBe("required"); // stays strict
    expect(eff.sessionTimeoutSeconds).toBe(3600); // the shorter (stricter) cap wins
  });

  it("intersects methods + allowlists; ORs the booleans", () => {
    const eff = resolveEffectivePolicy(
      {
        ...base,
        allowedMethods: ["password", "sso"],
        ipAllowlist: ["10.0.0.0/8", "192.168.0.0/16"],
      },
      { allowedMethods: ["sso", "passkey"], ipAllowlist: ["192.168.0.0/16"], requireSso: true },
    );
    expect(eff.allowedMethods).toEqual(["sso"]);
    expect(eff.ipAllowlist).toEqual(["192.168.0.0/16"]);
    expect(eff.requireSso).toBe(true);
  });
});

describe("composeEffectivePolicy (platform → org → workspace)", () => {
  it("folds three scopes strictest-wins; a child can only tighten the platform floor", () => {
    const platform: AuthPolicy = {
      ...base,
      mfaEnforcement: "optional",
      sessionTimeoutSeconds: 86400,
    };
    const org: Partial<AuthPolicy> = { mfaEnforcement: "required", sessionTimeoutSeconds: 7200 };
    const workspace: Partial<AuthPolicy> = { mfaEnforcement: "off", sessionTimeoutSeconds: 3600 }; // loosen attempt
    const eff = composeEffectivePolicy(platform, org, workspace);
    expect(eff.mfaEnforcement).toBe("required"); // org's tighten survives the workspace's loosen attempt
    expect(eff.sessionTimeoutSeconds).toBe(3600); // strictest (shortest) across all three
  });

  it("skips undefined overrides; the complete platform default passes through untouched", () => {
    const platform: AuthPolicy = { ...base, requireSso: true };
    expect(composeEffectivePolicy(platform, undefined, undefined)).toEqual(platform);
  });

  it("is order-independent for the result (the per-key ops are associative)", () => {
    const platform: AuthPolicy = { ...base, mfaEnforcement: "off" };
    const a: Partial<AuthPolicy> = { mfaEnforcement: "required" };
    const b: Partial<AuthPolicy> = { mfaEnforcement: "optional" };
    expect(composeEffectivePolicy(platform, a, b).mfaEnforcement).toBe(
      composeEffectivePolicy(platform, b, a).mfaEnforcement,
    );
  });
});

describe("assembleScopePolicy (auth_policies rows → typed partial)", () => {
  it("maps known keys + parses jsonb values", () => {
    const partial = assembleScopePolicy([
      { key: "mfa_enforcement", value: "required" },
      { key: "allowed_methods", value: ["password", "sso"] },
      { key: "disable_social", value: true },
      { key: "session_timeout_seconds", value: 3600 },
      { key: "ip_allowlist", value: ["10.0.0.0/8"] },
    ]);
    expect(partial).toEqual({
      mfaEnforcement: "required",
      allowedMethods: ["password", "sso"],
      disableSocial: true,
      sessionTimeoutSeconds: 3600,
      ipAllowlist: ["10.0.0.0/8"],
    });
  });

  it("ignores an unrecognised key (forward-compatible with a newer writer)", () => {
    expect(assembleScopePolicy([{ key: "future_knob", value: 42 }])).toEqual({});
  });

  it("SKIPS a malformed value instead of throwing — one bad row must not break login", () => {
    const partial = assembleScopePolicy([
      { key: "mfa_enforcement", value: "banana" }, // not in the enum
      { key: "session_timeout_seconds", value: -5 }, // not positive
      { key: "allowed_methods", value: "not-an-array" },
      { key: "require_sso", value: true }, // the one valid row survives
    ]);
    expect(partial).toEqual({ requireSso: true });
  });

  it("composes end-to-end: stored rows → partial → effective policy", () => {
    const platform: AuthPolicy = { ...base, mfaEnforcement: "optional" };
    const orgPartial = assembleScopePolicy([{ key: "mfa_enforcement", value: "required" }]);
    expect(composeEffectivePolicy(platform, orgPartial).mfaEnforcement).toBe("required");
  });
});

describe("resolvePolicyFromRows (scope partition + platform override + tighten)", () => {
  const floor = base; // hardcoded platform floor supplied by the repository
  const row = (
    scope: string,
    key: string,
    value: unknown,
    workspaceId: string | null = null,
  ): AuthPolicyRow => ({
    scope,
    workspaceId,
    key,
    value,
  });

  it("empty rows → the floor is returned unchanged", () => {
    expect(resolvePolicyFromRows([], undefined, floor)).toEqual(floor);
  });

  it("PLATFORM rows OVERRIDE the floor (a platform admin can set the baseline, even looser)", () => {
    // floor mfa is 'off' already; use a floor with 'required' to show platform can LOOSEN it (override, not tighten).
    const strictFloor = { ...floor, mfaEnforcement: "required" as const };
    const eff = resolvePolicyFromRows(
      [row("platform", "mfa_enforcement", "optional")],
      undefined,
      strictFloor,
    );
    expect(eff.mfaEnforcement).toBe("optional"); // override wins at the platform layer
  });

  it("ORG can only TIGHTEN the platform default, never loosen it", () => {
    const rows = [
      row("platform", "mfa_enforcement", "optional"),
      row("org", "mfa_enforcement", "required"), // tighten
    ];
    expect(resolvePolicyFromRows(rows, undefined, floor).mfaEnforcement).toBe("required");

    const loosenAttempt = [
      row("platform", "mfa_enforcement", "required"),
      row("org", "mfa_enforcement", "off"), // loosen attempt → rejected by strictest-wins
    ];
    expect(resolvePolicyFromRows(loosenAttempt, undefined, floor).mfaEnforcement).toBe("required");
  });

  it("applies ONLY the requested workspace's rows (a sibling workspace's rows are ignored)", () => {
    const rows = [
      row("org", "session_timeout_seconds", 7200),
      row("workspace", "session_timeout_seconds", 3600, "ws-A"),
      row("workspace", "session_timeout_seconds", 60, "ws-B"), // a stricter sibling — must NOT leak in
    ];
    expect(resolvePolicyFromRows(rows, "ws-A", floor).sessionTimeoutSeconds).toBe(3600);
    // with no workspace in scope, only org applies
    expect(resolvePolicyFromRows(rows, undefined, floor).sessionTimeoutSeconds).toBe(7200);
  });

  it("full chain: floor → platform → org → workspace, strictest-wins across the tighten layers", () => {
    const rows = [
      row("platform", "session_timeout_seconds", 86400),
      row("org", "session_timeout_seconds", 7200),
      row("workspace", "session_timeout_seconds", 3600, "ws-A"),
      row("org", "require_sso", true),
    ];
    const eff = resolvePolicyFromRows(rows, "ws-A", floor);
    expect(eff.sessionTimeoutSeconds).toBe(3600); // shortest across platform/org/workspace
    expect(eff.requireSso).toBe(true);
  });
});

describe("isMethodAllowed", () => {
  it("requireSso permits only sso; disableSocial blocks oauth", () => {
    expect(isMethodAllowed({ ...base, requireSso: true }, "password")).toBe(false);
    expect(isMethodAllowed({ ...base, requireSso: true }, "sso")).toBe(true);
    expect(isMethodAllowed({ ...base, disableSocial: true }, "oauth")).toBe(false);
    expect(isMethodAllowed(base, "passkey")).toBe(true);
  });
});
