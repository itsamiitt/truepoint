// evaluateCrmAlerts.test.ts — the CRM alert judgement (crm-sync 00 §9.5). Pure; no IO.
//
// Most of this file asserts what does NOT alert. An operator channel that fires on normal states gets muted,
// and a muted channel is worse than none — it converts a real incident into silence people have already
// learned to ignore. So the negative cases are the contract, not filler.

import { describe, expect, test } from "bun:test";
import {
  type CrmConnectionSnapshot,
  DEFAULT_CRM_ALERT_THRESHOLDS,
  evaluateCrmAlerts,
  evaluateCrmConnection,
  summariseCrmAlerts,
} from "./evaluateCrmAlerts.ts";

const NOW = Date.parse("2026-07-01T12:00:00Z");

const snap = (over: Partial<CrmConnectionSnapshot> = {}): CrmConnectionSnapshot => ({
  connectionId: "c1",
  tenantId: "t1",
  workspaceId: "w1",
  status: "connected",
  syncMode: "enforce",
  tokenExpiresAt: null,
  deadLetters: 0,
  openConflicts: 0,
  newestWatermark: new Date(NOW - 60_000),
  ...over,
});

const codes = (s: CrmConnectionSnapshot) =>
  evaluateCrmConnection(s, DEFAULT_CRM_ALERT_THRESHOLDS, NOW).map((a) => a.code);

describe("what does NOT alert", () => {
  test("a healthy enforcing connection is silent", () => {
    expect(codes(snap())).toEqual([]);
  });

  test("SHADOW is silent — it is the default state of every new connection", () => {
    expect(codes(snap({ syncMode: "shadow" }))).toEqual([]);
  });

  test("a PAUSED connection is silent, including its stale watermark", () => {
    // Pausing is a deliberate operator action. Its watermark is stale BY DESIGN, and alerting on that would
    // fire forever on every connection someone switched off on purpose.
    expect(
      codes(snap({ status: "paused", newestWatermark: new Date(NOW - 30 * 24 * 60 * 60_000) })),
    ).toEqual([]);
  });

  test("a DISCONNECTED connection is silent", () => {
    expect(codes(snap({ status: "disconnected", deadLetters: 999 }))).toEqual([]);
  });

  test("a SINGLE dead letter is not an outage", () => {
    // One poison record is a data problem on one row. Alerting on it would fire constantly on healthy
    // connections with one malformed CRM record nobody has cleaned up.
    expect(codes(snap({ deadLetters: 1 }))).toEqual([]);
    expect(codes(snap({ deadLetters: 9 }))).toEqual([]);
  });

  test("a handful of conflicts is the FEATURE WORKING, not a fault", () => {
    // Conflicts mean humans have edits worth protecting. Only a standing backlog says nobody is working it.
    expect(codes(snap({ openConflicts: 5 }))).toEqual([]);
  });

  test("a token expiring in the FUTURE is silent", () => {
    expect(codes(snap({ tokenExpiresAt: new Date(NOW + 60 * 60_000) }))).toEqual([]);
  });

  test("NO token expiry is silent — a non-expiring token is legitimate", () => {
    // SFDC issues no expires_in; a HubSpot private-app token is static.
    expect(codes(snap({ tokenExpiresAt: null }))).toEqual([]);
  });

  test("a connection that has never synced is silent, not 'stalled'", () => {
    // A null watermark means the first sync has not completed. That is a new connection, not a stuck one.
    expect(codes(snap({ newestWatermark: null }))).toEqual([]);
  });

  test("a DISABLED connection's stale watermark is silent — it is not trying to advance", () => {
    expect(
      codes(snap({ syncMode: "disabled", newestWatermark: new Date(NOW - 24 * 60 * 60_000) })),
    ).toEqual([]);
  });
});

describe("what DOES alert", () => {
  test("an errored connection is critical", () => {
    const alerts = evaluateCrmConnection(snap({ status: "error" }), undefined, NOW);
    expect(alerts[0]?.code).toBe("connection_error");
    expect(alerts[0]?.severity).toBe("critical");
  });

  test("an EXPIRED token is critical — the refresh path should have prevented it", () => {
    const alerts = evaluateCrmConnection(
      snap({ tokenExpiresAt: new Date(NOW - 1000) }),
      undefined,
      NOW,
    );
    expect(alerts.map((a) => a.code)).toContain("token_expired");
    expect(alerts.find((a) => a.code === "token_expired")?.severity).toBe("critical");
  });

  test("a dead-letter RATE alerts as a warning", () => {
    expect(codes(snap({ deadLetters: 10 }))).toContain("dead_letter_rate");
  });

  test("a conflict BACKLOG alerts as a warning", () => {
    expect(codes(snap({ openConflicts: 50 }))).toContain("conflict_backlog");
  });

  test("a stalled watermark alerts, and SHADOW is included — it still pulls", () => {
    const stalled = new Date(NOW - 7 * 60 * 60_000);
    expect(codes(snap({ newestWatermark: stalled }))).toContain("watermark_stalled");
    expect(codes(snap({ syncMode: "shadow", newestWatermark: stalled }))).toContain(
      "watermark_stalled",
    );
  });

  test("a connection reports EVERY applicable alert, not just the first", () => {
    // Reporting only the first would hide the backlog until the error was fixed.
    const alerts = codes(snap({ status: "error", deadLetters: 20, openConflicts: 60 }));
    expect(alerts).toContain("connection_error");
    expect(alerts).toContain("dead_letter_rate");
    expect(alerts).toContain("conflict_backlog");
  });
});

describe("facts carry no customer data", () => {
  test("every fact is a scalar count or timestamp", () => {
    const alerts = evaluateCrmConnection(
      snap({ status: "error", deadLetters: 20, tokenExpiresAt: new Date(NOW - 1) }),
      undefined,
      NOW,
    );
    for (const a of alerts) {
      for (const v of Object.values(a.facts)) {
        expect(["string", "number"]).toContain(typeof v);
      }
      // The code is a stable identifier, never an interpolated sentence — it has to be matchable.
      expect(a.code).not.toContain(" ");
    }
  });
});

describe("summarise", () => {
  test("collapses a fleet-wide incident into counts, not N lines", () => {
    const fleet = [
      snap({ connectionId: "a", status: "error" }),
      snap({ connectionId: "b", status: "error" }),
      snap({ connectionId: "c", deadLetters: 30 }),
    ];
    const s = summariseCrmAlerts(evaluateCrmAlerts(fleet, undefined, NOW));
    expect(s.total).toBe(3);
    expect(s.critical).toBe(2);
    expect(s.byCode.connection_error).toBe(2);
    expect(s.byCode.dead_letter_rate).toBe(1);
  });

  test("a healthy fleet summarises to zero, so the tick can stay silent", () => {
    const s = summariseCrmAlerts(
      evaluateCrmAlerts([snap(), snap({ syncMode: "shadow" })], undefined, NOW),
    );
    expect(s.total).toBe(0);
  });
});
