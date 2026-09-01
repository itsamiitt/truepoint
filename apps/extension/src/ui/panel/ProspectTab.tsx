// ProspectTab.tsx — the person half of the Profile Intelligence Panel: who they are, how to reach them, what
// the record says about them, and where they have worked and studied.
//
// The contact card is the only part that spends money, and it is written to be honest about that at every
// step: the price comes from the server's reveal costs (never a hardcoded number), values this workspace
// already owns are hydrated from the NO-CHARGE read rather than re-revealed, and "nothing on file" is said
// plainly instead of dressed up as a failed reveal.
import { useState } from "react";
import { t } from "../../i18n/index.ts";
import { send } from "../../shared/client.ts";
import {
  ageDays,
  contactSummary,
  dateRange,
  initials,
  joined,
  maskEmail,
  monogram,
  tenure,
} from "../../shared/intel/format.ts";
import type { IntelPayload } from "../../shared/messages.ts";
import type { RevealType } from "../../shared/types.ts";
import { deriveSignals } from "./intel/deriveSignals.ts";
import {
  Badge,
  type BadgeTone,
  Button,
  Chip,
  Muted,
  SectionLabel,
  Skeleton,
  Well,
  hairline,
  ink2,
  ink3,
  mono,
  surface3,
} from "./primitives.tsx";

/** The verification tone for an email status. Paired with text — the tone alone never carries the meaning. */
function emailTone(status: string | null | undefined): BadgeTone {
  if (status === "valid") return "success";
  if (status === "invalid" || status === "risky") return "warning";
  return "muted";
}

function IdentitySkeleton(): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 6 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Skeleton width={46} height={46} radius="50%" />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          <Skeleton width="52%" height={15} />
          <Skeleton width="80%" height={11} />
        </div>
      </div>
      {/* Radius tracks the Well it stands in (--tp-radius-card), so nothing reflows when the data lands. */}
      <Skeleton width="100%" height={104} radius={14} />
    </div>
  );
}

/**
 * The contact block. Four money-relevant states, and the difference between them is the whole point:
 *   • the workspace does not hold the person yet   → Save first (adding is free; revealing is not)
 *   • held, not revealed                            → Reveal, priced from the server
 *   • held and owned                                → the values, hydrated with no charge
 *   • held, revealed, and the record was empty      → "nothing on file", which is a demand signal, not a loss
 */
function ContactCard({
  payload,
  onRevealed,
}: {
  payload: IntelPayload;
  onRevealed: () => void;
}): React.ReactElement {
  const { intel, costs, revealed } = payload;
  const [busy, setBusy] = useState<RevealType | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justRevealed, setJustRevealed] = useState<{
    email?: string;
    phone?: string;
    nothing?: boolean;
    verification?: { lastVerifiedAt: string | null; sourceCount: number | null };
  } | null>(null);

  const contact = intel.contact;
  const person = intel.person;
  const hasEmail = contact?.hasEmail ?? person?.hasEmail ?? false;
  const hasPhone = contact?.hasPhone ?? person?.hasPhone ?? false;
  const email = justRevealed?.email ?? revealed?.email ?? null;
  const phone = justRevealed?.phone ?? revealed?.phone ?? null;
  // S-CH4: the no-charge read carries EVERY live value for owned types (primary-first); the scalars above
  // stay the primary. Everything beyond what the primary rows already show renders under "Also on record" —
  // the parity the web grid shipped (every email and phone a record holds). Gate-off the arrays are absent
  // and these are simply empty.
  const extraEmails = (revealed?.emails ?? []).filter((v) => v.value !== email);
  const extraPhones = (revealed?.phones ?? []).filter((v) => v.value !== phone);

  const reveal = async (type: RevealType): Promise<void> => {
    if (!intel.contactId) return;
    setBusy(type);
    setError(null);
    const res = await send({ type: "REVEAL", contactId: intel.contactId, revealType: type });
    setBusy(null);
    if (!res.ok) {
      setError(t(`error.${res.errorClass ?? "unexpected"}` as Parameters<typeof t>[0]));
      return;
    }
    // Merge ONLY what this response asserts: `nothingToReveal` and `verification` are optional on the
    // wire, and an unconditional assignment let a second reveal (e.g. the phone after the email) overwrite
    // an earlier true/verification with undefined — flipping "Nothing on file" back into reveal buttons
    // and dropping the confidence badge.
    setJustRevealed((prev) => ({
      ...prev,
      email: res.email ?? prev?.email,
      phone: res.phone ?? prev?.phone,
      nothing: res.nothingToReveal ?? prev?.nothing,
      verification: res.verification ?? prev?.verification,
    }));
    onRevealed();
  };

  const copy = (value: string): void => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  // The badge: recency now, corroboration only when the evidence log actually has something. A null source
  // count is "no log yet", which is true of nearly every record until the provenance gate is on — rendering
  // it as "0 sources" would stamp a false verdict across the whole database.
  const verification = justRevealed?.verification;
  const days = ageDays(verification?.lastVerifiedAt ?? contact?.lastVerifiedAt ?? null);
  const freshness =
    days === null
      ? t("card.notVerified")
      : days === 0
        ? t("card.verifiedToday")
        : t("card.verifiedDaysAgo").replace("{n}", String(days));
  const badgeText =
    verification?.sourceCount != null
      ? `${freshness} · ${t("card.sources").replace("{k}", String(verification.sourceCount))}`
      : freshness;

  return (
    <Well>
      <SectionLabel right={contactSummary(hasEmail, hasPhone)}>{t("contact.label")}</SectionLabel>

      {!intel.contactId ? (
        // In the database but not in this workspace: adding is free and is a separate, explicit gesture.
        // A one-click "save and reveal" would spend a credit on a button whose label said "save".
        //
        // NO MASKED EMAIL HERE, deliberately. A database person carries `hasEmail` and no domain — the only
        // domain in scope is the COMPANY's, and rendering `••••••••@acme.example` from it would assert we
        // hold an address at that domain when we may hold one anywhere or (if hasEmail is false) none at
        // all. The presence line above already says what we have; inventing the shape of it would be the
        // exact inference this panel promises not to make.
        <>
          <div style={{ fontSize: 13, color: ink3, marginTop: 9 }}>
            {hasEmail ? t("contact.emailOnRecord") : t("contact.noEmail")}
          </div>
          <Muted>{t("contact.saveToReveal")}</Muted>
        </>
      ) : email || phone ? (
        <div>
          {email ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
              <span
                style={{
                  fontSize: 15,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {email}
              </span>
              <Badge tone={emailTone(contact?.emailStatus)}>
                {contact?.emailStatus === "valid" ? t("badge.verified") : t("badge.unverified")}
              </Badge>
            </div>
          ) : null}
          {phone ? <div style={{ ...mono, fontSize: 14, marginTop: 6 }}>{phone}</div> : null}
          <div style={{ fontSize: 11, color: ink3, marginTop: 3 }}>{badgeText}</div>
          {extraEmails.length + extraPhones.length > 0 ? (
            <div style={{ marginTop: 11, paddingTop: 9, borderTop: `1px solid ${hairline}` }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: ink3,
                }}
              >
                {t("contact.alsoOnRecord")}
              </div>
              {extraEmails.map((v) => (
                <div
                  key={`e:${v.value}`}
                  style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {v.value}
                  </span>
                  <Badge tone={v.status === "valid" ? "success" : "muted"}>
                    {v.status === "valid" ? t("badge.verified") : t("badge.unverified")}
                  </Badge>
                </div>
              ))}
              {extraPhones.map((v) => (
                <div key={`p:${v.value}`} style={{ ...mono, fontSize: 13, marginTop: 5 }}>
                  {/* Line type is the pre-dial TCPA read (mobile vs landline) — a classification, shown
                      beside the value the way the per-call picker does. */}
                  {joined([v.value, v.lineType, v.type], " · ")}
                </div>
              ))}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 6, marginTop: 11, flexWrap: "wrap" }}>
            {email ? (
              <Button variant="secondary" onClick={() => copy(email)}>
                {copied ? t("contact.copied") : t("contact.copy")}
              </Button>
            ) : null}
            {email ? (
              <a
                href={`mailto:${email}`}
                style={{ textDecoration: "none" }}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="ghost">{t("contact.email")}</Button>
              </a>
            ) : null}
          </div>
          {!phone && hasPhone ? (
            <div style={{ marginTop: 13, paddingTop: 13, borderTop: `1px solid ${hairline}` }}>
              <Button
                variant="primary"
                full
                busy={busy === "phone"}
                onClick={() => void reveal("phone")}
              >
                {costs
                  ? t("contact.findPhone").replace("{n}", String(costs.phone))
                  : t("contact.findPhoneNoPrice")}
              </Button>
            </div>
          ) : null}
          {!hasPhone ? (
            <div style={{ marginTop: 13, paddingTop: 13, borderTop: `1px solid ${hairline}` }}>
              <Muted>{t("contact.noPhone")}</Muted>
            </div>
          ) : null}
        </div>
      ) : justRevealed?.nothing ? (
        // NOT "already owned": we hold nothing for this person. Saying otherwise is the bug the web UI had.
        <Muted>{t("card.nothingOnFile")}</Muted>
      ) : (
        <div>
          <div style={{ fontSize: 15, color: ink3, marginTop: 9, letterSpacing: "0.04em" }}>
            {maskEmail(contact?.emailDomain ?? null) ?? t("contact.noEmail")}
          </div>
          <div style={{ marginTop: 12 }}>
            <Button
              variant="primary"
              full
              busy={busy === "email"}
              disabled={!hasEmail}
              onClick={() => void reveal("email")}
            >
              {!hasEmail
                ? t("contact.noEmail")
                : costs
                  ? t("contact.reveal").replace("{n}", String(costs.email))
                  : t("contact.revealNoPrice")}
            </Button>
          </div>
          {hasEmail && hasPhone ? (
            // Both channels in one gesture (the Apollo "email & phone" parity). Priced from the server's
            // full_profile cost — one reveal_type, one idempotent charge — never the sum of the two.
            <div style={{ marginTop: 8 }}>
              <Button
                variant="secondary"
                full
                busy={busy === "full_profile"}
                onClick={() => void reveal("full_profile")}
              >
                {costs
                  ? t("contact.revealBoth").replace("{n}", String(costs.full_profile))
                  : t("contact.revealBothNoPrice")}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {error ? (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--danger-700, #b91c1c)" }}>
          {error}
        </div>
      ) : null}
    </Well>
  );
}

/** The signals list. Each row expands to the field, basis and grade it was derived from. */
function SignalsList({ payload }: { payload: IntelPayload }): React.ReactElement | null {
  const [open, setOpen] = useState<string | null>(null);
  const signals = deriveSignals(payload.intel);
  if (signals.length === 0) return null;

  return (
    <div>
      <SectionLabel>{t("signals.label")}</SectionLabel>
      {signals.map((s) => (
        <div key={s.id}>
          {/* A full-bleed disclosure ROW, not a Button: it spans the list, has no fill and no border, and
              carries aria-expanded. The primitive would have to grow three props to become this. Still a
              real <button type="button"> with the DS :focus-visible ring from brand.css. */}
          <button
            type="button"
            aria-expanded={open === s.id}
            onClick={() => setOpen((cur) => (cur === s.id ? null : s.id))}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "11px 0",
              background: "none",
              border: "none",
              borderBottom: `1px solid ${hairline}`,
              fontFamily: "inherit",
              textAlign: "left",
              cursor: "pointer",
              minHeight: 44,
            }}
          >
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.35 }}>{s.title}</span>
            <span style={{ fontSize: 12, color: ink3, whiteSpace: "nowrap" }}>{s.kind}</span>
          </button>
          {open === s.id ? (
            <div
              style={{
                ...mono,
                padding: "9px 0 11px",
                borderBottom: `1px solid ${hairline}`,
                display: "flex",
                flexDirection: "column",
                gap: 3,
                // The provenance a signal claim rests on. It is the evidence, not a footnote — it reads at
                // the same weight as the rest of the body copy, and at a contrast that passes AA.
                fontSize: 12,
                color: ink3,
                lineHeight: 1.55,
              }}
            >
              <div>{s.field}</div>
              <div>{s.basis}</div>
              <div>{s.grade}</div>
            </div>
          ) : null}
        </div>
      ))}
      <div style={{ marginTop: 9, fontSize: 12, color: ink3, lineHeight: 1.5 }}>
        {t("signals.footer")}
      </div>
    </div>
  );
}

export function ProspectTab({
  payload,
  loading,
  onChanged,
}: {
  payload: IntelPayload | null;
  loading: boolean;
  onChanged: () => void;
}): React.ReactElement {
  if (loading || !payload) return <IdentitySkeleton />;

  const { intel } = payload;
  const person = intel.person;
  const contact = intel.contact;
  const name = person?.fullName ?? joined([contact?.firstName, contact?.lastName]);
  const title = person?.jobTitle ?? contact?.jobTitle ?? person?.headline ?? null;
  const company = person?.companyName ?? contact?.companyName ?? null;
  const location =
    person?.locationRaw ?? joined([contact?.locationCity, contact?.locationCountry], ", ");
  const primary =
    intel.profile?.employment.find((e) => e.isPrimary && e.isCurrent) ??
    intel.profile?.employment.find((e) => e.isCurrent);
  const inSeat = primary ? tenure(primary.startedOn, primary.startPrecision) : null;
  const jobChange = intel.signals.find((s) => s.signal_type === "job_change") ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div style={{ display: "flex", gap: 13, alignItems: "center", paddingTop: 4 }}>
        {/* Initials, not a photo: profile pictures are retained raw-only and are never projected into the
            structured record (the 2026-08-16 decision), so the panel has none to show and does not pretend. */}
        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: "50%",
            background: surface3,
            display: "grid",
            placeItems: "center",
            flex: "none",
            fontSize: 13,
            fontWeight: 600,
            // The initials ARE the avatar, not a watermark behind one, so they owe AA as text. ink2, not the
            // ink3 the rest of the muted copy takes: this disc is --tp-surface-3, where ink3 measures 4.43:1
            // and lands just under the 4.5 floor (ink4 was 2.33:1). On surface-3 the muted ink runs out.
            color: ink2,
          }}
        >
          {initials(name)}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{ fontSize: 18, fontWeight: 650, letterSpacing: "-0.02em", lineHeight: 1.15 }}
          >
            {name ?? t("identity.unknownName")}
          </div>
          {title || company ? (
            <div style={{ fontSize: 13, color: ink2, marginTop: 3 }}>
              {[title, company].filter(Boolean).join(" · ")}
            </div>
          ) : null}
          <div style={{ fontSize: 12, color: ink3, marginTop: 2 }}>
            {joined(
              [location, inSeat ? t("identity.tenureInRole").replace("{tenure}", inSeat) : null],
              " · ",
            )}
          </div>
        </div>
      </div>

      {jobChange ? (
        // S-13 at eye level: the job-change sweep's finding was buried in a disclosure row; a saved contact
        // whose person moved is the single most time-sensitive fact this panel holds. The full provenance
        // stays in the Signals list — this is the same fact, made glanceable.
        <div>
          <Badge tone="warning">
            {`${t("signals.jobChangeBadge")} · ${jobChange.detected_at.slice(0, 10)}`}
          </Badge>
        </div>
      ) : null}

      <ContactCard payload={payload} onRevealed={onChanged} />

      <SignalsList payload={payload} />

      {intel.profile && intel.profile.employment.length > 0 ? (
        <div>
          <SectionLabel
            right={t("experience.count").replace("{n}", String(intel.profile.employment.length))}
          >
            {t("experience.label")}
          </SectionLabel>
          {intel.profile.employment.map((e, i) => (
            <div
              // Employment rows carry no id of their own (Layer-0 ids never cross the boundary), so the
              // composite of what identifies a stint is the key.
              key={`${e.companyName ?? "?"}-${e.title ?? "?"}-${e.startedOn ?? i}`}
              style={{
                display: "flex",
                gap: 11,
                padding: "11px 0",
                borderBottom: `1px solid ${hairline}`,
              }}
            >
              <div
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 5,
                  background: surface3,
                  flex: "none",
                  marginTop: 1,
                  display: "grid",
                  placeItems: "center",
                  fontSize: 11,
                  // ink2 for the same reason as the avatar above: the tile is --tp-surface-3, where ink3 is
                  // 4.43:1 — under AA, and at 11px there is no large-text allowance to fall back on.
                  color: ink2,
                }}
              >
                {monogram(e.companyName)}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>
                  {e.title ?? t("experience.untitled")}
                </div>
                <div style={{ fontSize: 12, color: ink3, marginTop: 1 }}>{e.companyName}</div>
                <div style={{ fontSize: 12, color: ink3, marginTop: 2 }}>
                  {dateRange(e) ?? t("education.noDates")}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {intel.profile && intel.profile.education.length > 0 ? (
        <div>
          <SectionLabel>{t("education.label")}</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {intel.profile.education.map((e, i) => (
              <div key={`${e.schoolName ?? "?"}-${e.degree ?? i}`}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {[e.degree, e.schoolName].filter(Boolean).join(" · ")}
                </div>
                <div style={{ fontSize: 12, color: ink3, marginTop: 1 }}>
                  {dateRange({ ...e, startPrecision: null, endPrecision: null }) ??
                    t("education.noDates")}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {intel.profile && intel.profile.skills.length > 0 ? (
        <div>
          <SectionLabel right={String(intel.profile.skills.length)}>
            {t("skills.label")}
          </SectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {intel.profile.skills.map((s) => (
              <Chip key={s}>{s}</Chip>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
