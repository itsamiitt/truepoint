// sendQuotaPeriod.test.ts — the send-quota window roll-over.
//
// The bug this pins: NOTHING reset `email_send_used`. `resetPeriod` existed, documented as driven by a "P6
// retention/period sweep" that was never built, and had no caller anywhere — found by auditing repository
// methods for call sites. Usage only ever went up, so a tenant with a quota burned it once and could never
// send again. It hid because `email_send_quota` has no default: every tenant is unlimited until an admin sets
// one, and the trap springs the moment one does.
//
// The roll-over decision is a pure function precisely so it can be asserted without a database.

import { describe, expect, test } from "bun:test";
import { SEND_QUOTA_PERIOD_DAYS, isPeriodElapsed } from "./sendQuotaRepository.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-22T12:00:00.000Z");

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

describe("send-quota period roll-over", () => {
  test("a window younger than the period has NOT elapsed", () => {
    expect(isPeriodElapsed(daysBefore(0), NOW)).toBe(false);
    expect(isPeriodElapsed(daysBefore(1), NOW)).toBe(false);
    expect(isPeriodElapsed(daysBefore(SEND_QUOTA_PERIOD_DAYS - 1), NOW)).toBe(false);
  });

  test("a window older than the period HAS elapsed — the case that never happened before", () => {
    expect(isPeriodElapsed(daysBefore(SEND_QUOTA_PERIOD_DAYS + 1), NOW)).toBe(true);
    // The one that matters most: a tenant whose counter has sat untouched for a year is not permanently
    // blocked. Before the roll-over existed, this was exactly the state a quota'd tenant ended up in.
    expect(isPeriodElapsed(daysBefore(365), NOW)).toBe(true);
  });

  test("the boundary is inclusive — exactly one period old is over", () => {
    const exactly = new Date(NOW.getTime() - SEND_QUOTA_PERIOD_DAYS * DAY_MS);
    expect(isPeriodElapsed(exactly, NOW)).toBe(true);
    // One millisecond short is not.
    expect(isPeriodElapsed(new Date(exactly.getTime() + 1), NOW)).toBe(false);
  });

  test("a future periodStart reads as not-elapsed rather than throwing", () => {
    // Clock skew between app servers, or a row stamped ahead. Resetting a live counter because a timestamp
    // looked wrong is the worse failure: it silently grants a tenant a fresh window it did not earn.
    expect(isPeriodElapsed(new Date(NOW.getTime() + 60_000), NOW)).toBe(false);
  });

  test("the period is a documented constant, not a magic number", () => {
    // Guards the assumption itself. If someone changes the window, this fails and sends them to the comment
    // on SEND_QUOTA_PERIOD_DAYS explaining that billing-cycle alignment is an open decision, not a free knob.
    expect(SEND_QUOTA_PERIOD_DAYS).toBe(30);
  });
});
