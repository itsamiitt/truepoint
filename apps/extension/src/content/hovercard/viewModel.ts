// viewModel.ts — PURE derivation of everything the hover card shows. No DOM, no chrome, no I/O: the whole
// Apollo-grade state ladder is a function from (lookup status × intel payload × credits × in-flight flags)
// to a paintable view-model, so the money-relevant rules — prices from the server, masked-shape-only-with-a-
// contact-row, "nothing on file" said plainly — are unit-tested here instead of living in event handlers.
//
// The honesty rules are the panel ContactCard's, restated for the in-page surface:
//   • Price labels come from the server's reveal costs; an unknown cost renders an UNPRICED label, never an
//     invented number.
//   • The masked `••••••••@domain` shape renders ONLY when the caller's workspace contact row exists (it is
//     the only place an email domain lives). A database-only person gets a presence line — inventing a
//     domain shape would assert an address we may not hold.
//   • `nothingToReveal` reads "nothing on file", never "already owned".
//   • Credits gating is best-effort UX (disable + hint); the server is the enforcer.
import { t } from "../../i18n/index.ts";
import {
  ageDays,
  initials,
  joined,
  maskEmail,
  monogram,
  signedPct,
} from "../../shared/intel/format.ts";
import { headcountWindows } from "../../shared/intel/headcount.ts";
import type { ViewedSubject } from "../../shared/linkedinUrl.ts";
import type { IntelPayload } from "../../shared/messages.ts";
import type { CapturedRecord, RevealCosts, RevealType, SubjectStatus } from "../../shared/types.ts";

export type IntelState = "idle" | "loading" | "ready" | "error";

export type PersonPhase =
  | "P0" // resolving — LOOKUP in flight
  | "P1" // suppressed
  | "P2" // queued locally
  | "P3" // not found
  | "P4" // source unavailable
  | "P5" // lookup failed / unknown
  | "P6" // intel loading
  | "P7" // in database, not in workspace
  | "P8" // found, not revealed
  | "P9" // revealed values on show
  | "P10" // revealed, nothing on file
  | "P11"; // intel failed — thin fallback

export interface RevealedNow {
  email?: string;
  phone?: string;
  nothing?: boolean;
  verification?: { lastVerifiedAt: string | null; sourceCount: number | null };
}

export interface PersonVmInput {
  record: CapturedRecord;
  status: SubjectStatus | null;
  intel: IntelPayload | null;
  intelState: IntelState;
  credits: number | null;
  busy: RevealType | null;
  justRevealed: RevealedNow | null;
  copied: "email" | "phone" | null;
  revealError: string | null;
}

export interface BadgeVm {
  tone: "success" | "warning" | "muted";
  text: string;
}

export interface ChannelVm {
  id: "email" | "phone";
  /** The display line: a revealed value, a masked shape, or a presence statement. */
  line: string;
  /** True when `line` is an actual revealed value — the renderer adds a Copy affordance. */
  isValue: boolean;
  masked: boolean;
  numeric: boolean;
  badge: BadgeVm | null;
  copied: boolean;
}

export type ActionId =
  | "save"
  | "add"
  | "openApp"
  | "revealEmail"
  | "revealPhone"
  | "retryLookup"
  | "retryIntel";

export interface ButtonVm {
  id: ActionId;
  label: string;
  kind: "primary" | "secondary";
  disabled: boolean;
}

export interface PersonCardVm {
  phase: PersonPhase;
  name: string;
  sub: string;
  meta: string | null;
  initials: string;
  pill: string;
  /** The one time-sensitive fact worth interrupting with (today: the job-change sweep's finding). */
  alert: string | null;
  hint: string | null;
  channels: ChannelVm[];
  freshnessLine: string | null;
  skeleton: boolean;
  buttons: ButtonVm[];
  openPanelLabel: string | null;
  error: string | null;
}

/** "Found in TruePoint · updated N days ago" from the workspace copy's freshness stamp. */
export function freshnessLabel(lastUpdatedAt: string | null | undefined): string {
  const days = ageDays(lastUpdatedAt ?? null);
  if (days === null) return t("card.inTruePoint");
  if (days === 0) return t("card.updatedToday");
  return t("card.updatedDaysAgo", { n: days });
}

/**
 * The "Open in TruePoint" destination. `/search?person=<slug>` deep-opens the person's profile drawer in the
 * app (the param useProfileParam already reserves); the slug ladder mirrors the identity ladder — server
 * intel, then the lookup's masked identity, then the DOM capture, then the subject key itself when it IS the
 * public slug (a `sales-lead:<id>` key carries a colon and is never a slug). No slug → the bare workspace.
 */
export function personDeepLink(
  appOrigin: string,
  input: {
    intel: IntelPayload | null;
    status: SubjectStatus | null;
    record: CapturedRecord | null;
  },
): string {
  const slug =
    input.intel?.intel.person?.linkedinPublicId ??
    input.status?.identity?.linkedinPublicId ??
    input.record?.fields.publicId ??
    (input.record && !input.record.subjectKey.includes(":") ? input.record.subjectKey : null);
  return slug ? `${appOrigin}/search?person=${encodeURIComponent(slug)}` : `${appOrigin}/search`;
}

export function errorMessage(errorClass?: string): string {
  switch (errorClass) {
    case "auth":
      return t("error.auth");
    case "rate_limit":
      return t("error.rate_limit");
    case "transient":
      return t("error.transient");
    default:
      return t("error.unexpected");
  }
}

/** A reveal button, priced from the SERVER's costs — an unknown cost renders unpriced, never a made-up "1". */
function revealButton(
  id: "revealEmail" | "revealPhone",
  kind: "primary" | "secondary",
  costs: RevealCosts | null,
  credits: number | null,
  busyType: RevealType | null,
): { button: ButtonVm; short: boolean } {
  const type: RevealType = id === "revealEmail" ? "email" : "phone";
  const cost = costs ? costs[type] : null;
  const short = cost !== null && credits !== null && credits < cost;
  const busy = busyType === type;
  const label = busy
    ? t("card.revealing")
    : cost !== null
      ? t(id === "revealEmail" ? "card.revealEmail" : "card.revealPhone", { n: cost })
      : t(id === "revealEmail" ? "card.revealEmailNoPrice" : "card.revealPhoneNoPrice");
  return { button: { id, label, kind, disabled: short || busy }, short };
}

/** The verification line under revealed values: recency, plus corroboration only when the log holds any. */
function verificationLine(
  verification: RevealedNow["verification"] | undefined,
  fallbackVerifiedAt: string | null,
): string {
  const days = ageDays(verification?.lastVerifiedAt ?? fallbackVerifiedAt);
  const freshness =
    days === null
      ? t("card.notVerified")
      : days === 0
        ? t("card.verifiedToday")
        : t("card.verifiedDaysAgo", { n: days });
  return verification?.sourceCount != null
    ? `${freshness} · ${t("card.sources", { k: verification.sourceCount })}`
    : freshness;
}

export function derivePersonVm(input: PersonVmInput): PersonCardVm {
  const { record, status, intel, intelState, credits, busy, justRevealed, copied, revealError } =
    input;

  const person = intel?.intel.person ?? null;
  const contact = intel?.intel.contact ?? null;

  // Identity ladder: server intel > lookup's masked identity > the DOM capture. Never invented.
  const name =
    person?.fullName ??
    joined([contact?.firstName, contact?.lastName]) ??
    status?.identity?.fullName ??
    record.fields.fullName ??
    record.subjectKey;
  const title =
    person?.jobTitle ??
    contact?.jobTitle ??
    person?.headline ??
    status?.identity?.jobTitle ??
    record.fields.jobTitle ??
    null;
  const company =
    person?.companyName ??
    contact?.companyName ??
    status?.identity?.company ??
    record.fields.company ??
    null;
  const location =
    person?.locationRaw ??
    joined([contact?.locationCity, contact?.locationCountry], ", ") ??
    status?.identity?.location ??
    record.fields.location ??
    null;

  // S-13 at the surface a rep actually sees: the job-change sweep's finding rides the intel signals, and a
  // stale saved contact is the most time-sensitive fact this card can carry. Composed here so every
  // intel-carrying phase inherits it; no intel yet (or failed) → no claim.
  const jobChange = intel?.intel.signals.find((s) => s.signal_type === "job_change") ?? null;

  const base: PersonCardVm = {
    phase: "P0",
    name,
    sub: joined([title, company], " · ") ?? "",
    meta: location,
    initials: initials(name),
    pill: t("card.checking"),
    alert: jobChange
      ? `${t("signals.jobChangeBadge")} · ${jobChange.detected_at.slice(0, 10)}`
      : null,
    hint: null,
    channels: [],
    freshnessLine: null,
    skeleton: false,
    buttons: [],
    openPanelLabel: null,
    error: revealError,
  };

  if (!status) return base; // P0 — LOOKUP in flight

  const save: ButtonVm = { id: "save", label: t("card.save"), kind: "primary", disabled: false };

  switch (status.outcome) {
    case "suppressed":
      return { ...base, phase: "P1", pill: t("card.suppressed") };
    case "queued":
      return { ...base, phase: "P2", pill: t("card.queued"), buttons: [save] };
    case "not_found":
      return { ...base, phase: "P3", pill: t("card.notFoundPill"), buttons: [save] };
    case "unavailable":
      return {
        ...base,
        phase: "P4",
        pill: t("card.unavailablePill"),
        hint: t("card.unavailableHint"),
        buttons: [save],
      };
    case "found":
    case "in_database":
      break;
    default:
      // "unknown" and the transient capture outcomes: the check itself failed — offer a retry, keep Save.
      return {
        ...base,
        phase: "P5",
        pill: t("card.checkFailed"),
        buttons: [
          { id: "retryLookup", label: t("panel.retry"), kind: "secondary", disabled: false },
          save,
        ],
      };
  }

  const lookupPill =
    status.outcome === "found"
      ? freshnessLabel(status.lastUpdatedAt ?? null)
      : t("card.inDatabasePill");

  if (intelState === "loading" || intelState === "idle") {
    return { ...base, phase: "P6", pill: lookupPill, skeleton: true };
  }

  if (intelState === "error" || !intel) {
    // P11 — the deep read failed; fall back to exactly the thin card this surface used to be, plus the
    // same retry the company card offers (C3): an intel failure is usually transient, and without the
    // affordance the person card was the one surface where a rep could not re-ask.
    const retry: ButtonVm = {
      id: "retryIntel",
      label: t("panel.retry"),
      kind: "secondary",
      disabled: false,
    };
    if (status.outcome === "in_database") {
      return {
        ...base,
        phase: "P11",
        pill: lookupPill,
        hint: t("card.inDatabaseHint"),
        buttons: [
          { id: "add", label: t("card.addToWorkspace"), kind: "primary", disabled: false },
          retry,
        ],
        openPanelLabel: t("card.openFullProfile"),
      };
    }
    const thin: ButtonVm = status.owned
      ? { id: "openApp", label: t("card.openInApp"), kind: "primary", disabled: false }
      : revealButton("revealEmail", "primary", intel?.costs ?? null, credits, busy).button;
    return {
      ...base,
      phase: "P11",
      pill: lookupPill,
      buttons: [thin, retry],
      openPanelLabel: t("card.openFullProfile"),
    };
  }

  const contactId = intel.intel.contactId;
  const hasEmail = contact?.hasEmail ?? person?.hasEmail ?? false;
  const hasPhone = contact?.hasPhone ?? person?.hasPhone ?? false;

  if (!contactId) {
    // P7 — the platform database holds the person; the workspace does not. Adding is free; presence only
    // (no masked domain — the workspace row that carries one does not exist yet).
    return {
      ...base,
      phase: "P7",
      pill: t("card.inDatabasePill"),
      hint: t("card.inDatabaseHint"),
      channels: [
        {
          id: "email",
          line: hasEmail ? t("contact.emailOnRecord") : t("contact.noEmail"),
          isValue: false,
          masked: false,
          numeric: false,
          badge: null,
          copied: false,
        },
        {
          id: "phone",
          line: hasPhone ? t("card.phoneOnRecord") : t("contact.noPhone"),
          isValue: false,
          masked: false,
          numeric: false,
          badge: null,
          copied: false,
        },
      ],
      buttons: [{ id: "add", label: t("card.addToWorkspace"), kind: "primary", disabled: false }],
      openPanelLabel: t("card.openFullProfile"),
    };
  }

  const email = justRevealed?.email ?? intel.revealed?.email ?? null;
  const phone = justRevealed?.phone ?? intel.revealed?.phone ?? null;

  if (justRevealed?.nothing && !email && !phone) {
    // P10 — the reveal succeeded and the record held nothing. A demand signal, not an ownership claim.
    return {
      ...base,
      phase: "P10",
      pill: lookupPill,
      hint: t("card.nothingOnFile"),
      openPanelLabel: t("card.openFullProfile"),
    };
  }

  if (email || phone) {
    // P9 — owned values on show, with the verification badge and a Copy per value. A channel the record
    // holds but the workspace has not paid for keeps its Reveal button.
    const channels: ChannelVm[] = [];
    if (email) {
      channels.push({
        id: "email",
        line: email,
        isValue: true,
        masked: false,
        numeric: false,
        badge:
          contact?.emailStatus === "valid"
            ? { tone: "success", text: t("badge.verified") }
            : { tone: "muted", text: t("badge.unverified") },
        copied: copied === "email",
      });
    } else {
      channels.push({
        id: "email",
        line: hasEmail ? t("contact.emailOnRecord") : t("contact.noEmail"),
        isValue: false,
        masked: false,
        numeric: false,
        badge: null,
        copied: false,
      });
    }
    if (phone) {
      channels.push({
        id: "phone",
        line: phone,
        isValue: true,
        masked: false,
        numeric: true,
        badge: null,
        copied: copied === "phone",
      });
    } else {
      channels.push({
        id: "phone",
        line: hasPhone ? t("card.phoneOnRecord") : t("contact.noPhone"),
        isValue: false,
        masked: false,
        numeric: false,
        badge: null,
        copied: false,
      });
    }

    const buttons: ButtonVm[] = [];
    let short = false;
    if (!email && hasEmail) {
      const r = revealButton("revealEmail", "primary", intel.costs, credits, busy);
      buttons.push(r.button);
      short = short || r.short;
    }
    if (!phone && hasPhone) {
      const r = revealButton(
        "revealPhone",
        buttons.length ? "secondary" : "primary",
        intel.costs,
        credits,
        busy,
      );
      buttons.push(r.button);
      short = short || r.short;
    }
    buttons.push({
      id: "openApp",
      label: t("card.openInApp"),
      kind: buttons.length ? "secondary" : "primary",
      disabled: false,
    });

    return {
      ...base,
      phase: "P9",
      pill: t("card.revealed"),
      hint: short ? t("card.outOfCredits") : null,
      channels,
      freshnessLine: verificationLine(justRevealed?.verification, contact?.lastVerifiedAt ?? null),
      buttons,
      openPanelLabel: t("card.openFullProfile"),
    };
  }

  // P8 — held, not revealed: the masked shape (workspace row exists, so the domain is real), presence for
  // the phone, and the per-type money buttons priced from the server.
  const channels: ChannelVm[] = [
    {
      id: "email",
      line: hasEmail
        ? (maskEmail(contact?.emailDomain ?? null) ?? t("contact.emailOnRecord"))
        : t("contact.noEmail"),
      isValue: false,
      masked: hasEmail && Boolean(contact?.emailDomain),
      numeric: false,
      badge:
        hasEmail && contact?.emailStatus === "valid"
          ? { tone: "success", text: t("badge.verified") }
          : null,
      copied: false,
    },
    {
      id: "phone",
      line: hasPhone ? t("card.phoneOnRecord") : t("contact.noPhone"),
      isValue: false,
      masked: false,
      numeric: false,
      badge: null,
      copied: false,
    },
  ];

  const buttons: ButtonVm[] = [];
  let short = false;
  if (hasEmail) {
    const r = revealButton("revealEmail", "primary", intel.costs, credits, busy);
    buttons.push(r.button);
    short = short || r.short;
  }
  if (hasPhone) {
    const r = revealButton(
      "revealPhone",
      buttons.length ? "secondary" : "primary",
      intel.costs,
      credits,
      busy,
    );
    buttons.push(r.button);
    short = short || r.short;
  }

  return {
    ...base,
    phase: "P8",
    pill: lookupPill,
    hint: short ? t("card.outOfCredits") : null,
    channels,
    buttons,
    openPanelLabel: t("card.openFullProfile"),
  };
}

// ── Company card ────────────────────────────────────────────────────────────────────────────────────

export type CompanyPhase = "C0" | "C1" | "C2" | "C3";

export interface CompanyVmInput {
  subject: ViewedSubject;
  intel: IntelPayload | null;
  intelState: IntelState;
}

export interface CompanyCardVm {
  phase: CompanyPhase;
  name: string;
  monogram: string;
  logoUrl: string | null;
  sub: string | null;
  pill: string | null;
  headcount: { count: string; growth: string | null } | null;
  foundedHq: string | null;
  hint: string | null;
  buttons: ButtonVm[];
  openPanelLabel: string | null;
}

/**
 * A provisional display name from the URL slug, shown only while the server answers. A Sales-Nav company
 * URL carries a NUMERIC id, which must never be shown (the README front-end contract: URL-shaped
 * identifiers may render, numeric ids never) — it humanizes to the generic "Company" label instead.
 */
export function humanizeSlug(subjectKey: string): string {
  const slug = subjectKey.replace(/^company:/, "");
  if (/^\d+$/.test(slug)) return t("card.companyLoading");
  const words = slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length > 0 ? words.join(" ") : t("card.companyLoading");
}

export function deriveCompanyVm(input: CompanyVmInput): CompanyCardVm {
  const { subject, intel, intelState } = input;
  const provisional = humanizeSlug(subject.subjectKey);

  const base: CompanyCardVm = {
    phase: "C0",
    name: provisional,
    monogram: monogram(provisional),
    logoUrl: null,
    sub: null,
    pill: t("card.checking"),
    headcount: null,
    foundedHq: null,
    hint: null,
    buttons: [],
    openPanelLabel: null,
  };

  if (intelState === "loading" || intelState === "idle") return base;

  if (intelState === "error" || !intel) {
    return {
      ...base,
      phase: "C3",
      pill: t("card.checkFailed"),
      hint: t("error.transient"),
      buttons: [{ id: "retryIntel", label: t("panel.retry"), kind: "secondary", disabled: false }],
    };
  }

  const block = intel.intel.company;
  if (!block) {
    return {
      ...base,
      phase: "C2",
      pill: t("company.emptyTitle"),
      hint: t("company.emptyHint"),
    };
  }

  const c = block.company;
  const series = block.headcountSeries;
  const latest = series.at(-1)?.employeeCount ?? c.employeeCount;
  const twelveMo = headcountWindows(series).find((w) => w.months === 12);
  const growth = signedPct(twelveMo?.pct ?? null);
  const founded = c.yearFounded ? t("card.companyFounded", { year: c.yearFounded }) : null;
  const hq = joined([c.hqCity, c.hqCountry], ", ");

  return {
    ...base,
    phase: "C1",
    name: c.name,
    monogram: monogram(c.name),
    logoUrl: c.logoUrl,
    sub: joined([c.industryLabel ?? c.industry, c.primaryDomain], " · "),
    pill: null,
    headcount:
      latest !== null
        ? {
            count: `${latest.toLocaleString("en-US")} ${t("company.employees")}`,
            growth: growth ? `${growth} · ${t("company.twelveMonths")}` : null,
          }
        : null,
    foundedHq: joined([founded, hq], " · "),
    openPanelLabel: t("card.openCompanyProfile"),
  };
}
