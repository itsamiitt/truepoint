// deriveSignals.ts — PURE: the panel's "Signals" list, derived from the record the server already returned.
//
// THE RULE THIS FILE EXISTS TO KEEP: nothing is inferred beyond the record. Every signal carries the FIELD it
// came from, the BASIS (what that field actually says) and a GRADE (how much weight the field can bear), and
// the UI shows all three on tap. That is not decoration — it is the difference between an intelligence panel
// and a horoscope, and it is what makes [A-01] true at the surface a seller actually looks at.
//
// Consequences of that rule, worth stating because each one was a temptation:
//   • No AI, no scoring model, no "intent" — X-04 is a deferred non-goal and person-level intent is out of
//     scope by decision (market-intelligence D-1). A signal here is a restatement of a stored fact.
//   • Nothing derived from free text. The company description is not mined for "integrations" or
//     "competitors": a keyword match over prose is an inference wearing a fact's clothes.
//   • A signal that would need a field we do not hold is simply not emitted. Coverage is honest or absent.
//
// Server-side signals (`intent_signals`) are merged in rather than recomputed — today only `job_change` has a
// producer (the S-13 sweep), and listing the other eight enum values would advertise coverage that does not
// exist.
import type { ProfileIntelResponse } from "@leadwolf/types";
import { headcountWindows } from "../../../shared/intel/headcount.ts";

/** The row's category. Ordered here as they are rendered — the sort order below depends on it. */
export type SignalKind = "people" | "growth" | "caution" | "data quality";

export interface DerivedSignal {
  /** Stable id — the i18n key suffix and the React key. */
  id: string;
  kind: SignalKind;
  /** The one-line claim. */
  title: string;
  /** The record field it came from, in the source's own vocabulary. */
  field: string;
  /** What that field says, quoted plainly. */
  basis: string;
  /** How much weight the field can bear — including when the answer is "not much". */
  grade: string;
}

const ORDER: Record<SignalKind, number> = {
  people: 0,
  growth: 1,
  caution: 2,
  "data quality": 3,
};

/** Whole months between an ISO date and `now`; null when the date is absent or year-precision only. */
function monthsSince(iso: string | null, precision: string | null, now: Date): number | null {
  if (!iso || precision === "year") return null;
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return null;
  return (now.getFullYear() - Number(m[1])) * 12 + (now.getMonth() + 1 - Number(m[2]));
}

/**
 * Derive the signal rows for one subject.
 *
 * `now` is injectable so tenure-dependent rules are testable without fake timers (the captureQueue.due
 * convention).
 */
export function deriveSignals(
  intel: ProfileIntelResponse,
  now: Date = new Date(),
): DerivedSignal[] {
  const out: DerivedSignal[] = [];
  const primary =
    intel.profile?.employment.find((e) => e.isPrimary && e.isCurrent) ??
    intel.profile?.employment.find((e) => e.isCurrent);

  // ── People ───────────────────────────────────────────────────────────────────────────────────────────
  if (primary?.startedOn && primary.startPrecision !== "year") {
    const months = monthsSince(primary.startedOn, primary.startPrecision, now);
    if (months !== null && months >= 0) {
      const title =
        months < 3
          ? `New in seat — ${months === 0 ? "under a month" : `${months} month${months === 1 ? "" : "s"}`}`
          : `In seat ${Math.floor(months / 12) > 0 ? `${Math.floor(months / 12)}y ` : ""}${months % 12}m`;
      out.push({
        id: "role_tenure",
        kind: "people",
        title,
        field: "employment.started_on",
        basis: `${primary.title ?? "Current role"} since ${primary.startedOn.slice(0, 7)}`,
        // The first-90-days window is a stated convention, not a claim about this person: a new leader is
        // reviewing tooling; a settled one is not. Saying which side of it they are on is a fact about the
        // date. Saying what they will therefore DO would not be.
        grade: months < 3 ? "inside the first-90-days window" : "past the first-90-days window",
      });
    }
  }

  for (const s of intel.signals) {
    if (s.signal_type !== "job_change") continue;
    out.push({
      id: `job_change:${s.detected_at}`,
      kind: "people",
      title: "Job change detected on this contact",
      field: "intent_signals.job_change",
      basis: `detected ${s.detected_at.slice(0, 10)}`,
      grade: "observed by the job-change sweep",
    });
  }

  // ── Growth (company facts; no person is involved) ─────────────────────────────────────────────────────
  const series = intel.company?.headcountSeries ?? [];
  if (series.length >= 2) {
    const windows = headcountWindows(series);
    const oneYear = windows.find((w) => w.months === 12);
    const oneMonth = windows.find((w) => w.months === 1);

    if (oneYear?.pct !== null && oneYear?.pct !== undefined && Math.abs(oneYear.pct) >= 25) {
      const up = oneYear.pct > 0;
      out.push({
        id: up ? "headcount_growth_12m" : "headcount_decline_12m",
        kind: up ? "growth" : "caution",
        title: `Headcount ${up ? "up" : "down"} ${Math.abs(Math.round(oneYear.pct))}% in twelve months`,
        field: "headcount.monthly",
        basis: `${oneYear.from} → ${oneYear.to} employees`,
        grade: "reported monthly by the source",
      });
    }

    if (oneMonth?.pct === 0 && series.length >= 3) {
      out.push({
        id: "growth_paused",
        kind: "caution",
        title: "Hiring flat over the last month",
        field: "headcount.monthly",
        basis: `${oneMonth.from} → ${oneMonth.to}, change 0`,
        // One month is one data point. Saying so is the whole value of the row.
        grade: "single-month reading, treat as weak",
      });
    }
  }

  // ── Data quality (what NOT to trust — as much a signal as what to) ────────────────────────────────────
  const company = intel.company?.company;
  if (company?.revenueDisplay && company.employeeCount !== null && series.length >= 2) {
    const first = series[0]?.employeeCount ?? 0;
    if (first > 0 && company.employeeCount >= first * 2) {
      out.push({
        id: "revenue_band_stale",
        kind: "data quality",
        title: "Revenue band predates the headcount change",
        field: "revenue_range",
        basis: `${company.revenueDisplay} against ${company.employeeCount} staff`,
        grade: "stale field — do not quote",
      });
    }
  }

  const contact = intel.contact;
  if (contact) {
    if (
      contact.hasEmail &&
      (contact.emailStatus === "unverified" || contact.emailStatus === "unknown")
    ) {
      out.push({
        id: "email_unverified",
        kind: "data quality",
        title: "Email has never been verified",
        field: "contacts.email_status",
        basis: `status ${contact.emailStatus}`,
        grade: "unverified — bounce risk on first contact",
      });
    }
    if (!contact.hasPhone) {
      out.push({
        id: "no_phone",
        kind: "data quality",
        title: "No phone on record",
        field: "contacts.has_phone",
        basis: "no phone value held for this contact",
        grade: "absence of a value, not a failed lookup",
      });
    }
    // The phone twin of the email row — the asymmetry hid dial risk while bounce risk was surfaced.
    // `== null` on purpose: phone_status is null until a verification has graded the number.
    if (contact.hasPhone && (contact.phoneStatus == null || contact.phoneStatus === "unknown")) {
      out.push({
        id: "phone_unverified",
        kind: "data quality",
        title: "Phone has never been verified",
        field: "contacts.phone_status",
        basis: `status ${contact.phoneStatus ?? "not graded"}`,
        grade: "unverified — dial risk on first call",
      });
    }
    if (contact.hasPhone && contact.phoneStatus === "invalid") {
      out.push({
        id: "phone_invalid",
        kind: "caution",
        title: "Phone failed verification",
        field: "contacts.phone_status",
        basis: "status invalid",
        grade: "verified bad — do not dial",
      });
    }
  }

  return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}
