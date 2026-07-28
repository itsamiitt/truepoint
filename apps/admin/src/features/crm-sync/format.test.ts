// format.test.ts — the monitor's classification judgement (crm-sync 00 §9). Pure; no DOM, no network.
//
// The behaviour worth pinning is what does NOT alert. Every connection starts in `shadow`, so a monitor that
// flagged the default state would be permanently red and therefore ignored — alert fatigue is the failure
// mode that makes an operator console useless.

import { describe, expect, test } from "bun:test";
import { classifyConnection, needsAttention } from "./format";
import type { StaffCrmConnection } from "./types";

const NOW = Date.parse("2026-07-01T00:00:00Z");

const conn = (over: Partial<StaffCrmConnection> = {}): StaffCrmConnection => ({
  id: "c1",
  tenantId: "t1",
  workspaceId: "w1",
  provider: "salesforce",
  status: "connected",
  syncMode: "enforce",
  environment: "production",
  externalAccountId: "ORG-1",
  lastError: null,
  lastRefreshAt: null,
  tokenExpiresAt: null,
  nextPollAt: null,
  connectedAt: null,
  ...over,
});

describe("what alerts", () => {
  test("an errored connection alerts regardless of mode", () => {
    const h = classifyConnection(conn({ status: "error", syncMode: "shadow" }), NOW);
    expect(h.needsAttention).toBe(true);
    expect(h.tone).toBe("danger");
  });

  test("an EXPIRED token alerts", () => {
    // Otherwise it presents as intermittent provider failures until someone notices the expiry.
    const h = classifyConnection(conn({ tokenExpiresAt: "2026-06-30T00:00:00Z" }), NOW);
    expect(h.needsAttention).toBe(true);
    expect(h.label).toBe("Token expired");
  });

  test("error outranks an expired token — the more specific breakage wins the label", () => {
    const h = classifyConnection(
      conn({ status: "error", tokenExpiresAt: "2026-06-30T00:00:00Z" }),
      NOW,
    );
    expect(h.label).toBe("Error");
  });
});

describe("what deliberately does NOT alert", () => {
  test("SHADOW is information, not an alert", () => {
    // Every connection starts here by design. Flagging the default state would make the monitor
    // permanently red and therefore ignored.
    const h = classifyConnection(conn({ syncMode: "shadow" }), NOW);
    expect(h.needsAttention).toBe(false);
    expect(h.tone).toBe("warning");
    expect(h.label).toBe("Preview");
  });

  for (const status of ["pending", "paused", "disconnected"]) {
    test(`${status} is muted, not an alert — it is a deliberate state`, () => {
      const h = classifyConnection(conn({ status }), NOW);
      expect(h.needsAttention).toBe(false);
      expect(h.tone).toBe("muted");
    });
  }

  test("a connection with sync switched off is muted", () => {
    expect(classifyConnection(conn({ syncMode: "disabled" }), NOW).needsAttention).toBe(false);
  });

  test("a token expiring in the FUTURE is healthy", () => {
    const h = classifyConnection(conn({ tokenExpiresAt: "2099-01-01T00:00:00Z" }), NOW);
    expect(h.label).toBe("Syncing");
    expect(h.needsAttention).toBe(false);
  });

  test("no expiry at all is healthy — a non-expiring token is legitimate", () => {
    // SFDC issues no expires_in, and a HubSpot private-app token is static.
    expect(classifyConnection(conn({ tokenExpiresAt: null }), NOW).label).toBe("Syncing");
  });
});

describe("needsAttention filter", () => {
  test("returns only the rows an operator should act on", () => {
    const rows = [
      conn({ id: "ok" }),
      conn({ id: "shadow", syncMode: "shadow" }),
      conn({ id: "broken", status: "error" }),
      conn({ id: "expired", tokenExpiresAt: "2020-01-01T00:00:00Z" }),
    ];
    expect(
      needsAttention(rows, NOW)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["broken", "expired"]);
  });

  test("a healthy fleet yields an empty list, not a falsy value", () => {
    expect(needsAttention([conn(), conn({ syncMode: "shadow" })], NOW)).toEqual([]);
  });
});
