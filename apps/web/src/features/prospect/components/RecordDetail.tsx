// RecordDetail.tsx — the right slide-over record detail (04 §6, 11 §4.2). A single soft-shadowed panel over
// the grid that preserves context: identity, the lead-score block (fetched on open via fetchScores, ADR-0008
// — distinct from email_status), the masked email/phone facets, and the Reveal action. Reveal opens the
// confirmation dialog (RevealDialog); the actual charge/gate run server-side. Esc closes the panel.
"use client";

import type { MaskedContact, RevealType } from "@leadwolf/types";
import { useEffect, useState } from "react";
import { type ScoreHistoryRow, fetchScores } from "../api";
import {
  EMAIL_STATUS_LABELS,
  SENIORITY_LABELS,
  displayName,
  emailGlyphFor,
  maskedEmail,
} from "../types";
import { RevealDialog } from "./RevealDialog";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="tp-detail-field">
      <span className="tp-detail-label">{label}</span>
      <span className="tp-detail-value">{value}</span>
    </div>
  );
}

function ScorePanel({ contactId }: { contactId: string }) {
  const [scores, setScores] = useState<ScoreHistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const rows = await fetchScores(contactId);
        if (live) setScores(rows);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Could not load scores");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [contactId]);

  if (loading) return <p className="app-muted">Loading score…</p>;
  if (error) return <p className="lw-error">{error}</p>;

  const latest = scores?.[0];
  if (!latest) return <p className="app-muted">Not scored yet.</p>;

  return (
    <div className="tp-score-grid">
      <div className="tp-score-composite">
        <span className="tp-score-big">{latest.compositeScore}</span>
        <span className="tp-detail-label">Composite</span>
      </div>
      <div className="tp-score-parts">
        <Field label="ICP fit" value={String(latest.icpFit)} />
        <Field label="Intent" value={String(latest.intentScore)} />
        <Field label="Engagement" value={String(latest.engagementScore)} />
      </div>
    </div>
  );
}

export function RecordDetail({
  contact,
  onClose,
  onRevealed,
}: {
  contact: MaskedContact;
  onClose: () => void;
  onRevealed: (contactId: string) => void;
}) {
  const [revealType, setRevealType] = useState<RevealType | null>(null);
  const glyph = emailGlyphFor(contact);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc closes the slide-over — but let the dialog handle its own Esc first when open.
      if (e.key === "Escape" && revealType === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, revealType]);

  const location =
    [contact.locationCity, contact.locationCountry].filter(Boolean).join(", ") || "—";

  return (
    <aside className="tp-slideover" aria-label="Record detail">
      <header className="tp-slideover-head">
        <div>
          <h2 className="tp-slideover-title">{displayName(contact)}</h2>
          <p className="tp-slideover-sub">{contact.jobTitle ?? "—"}</p>
        </div>
        <button className="tp-icon-btn" type="button" onClick={onClose} aria-label="Close detail">
          ✕
        </button>
      </header>

      <div className="tp-slideover-body">
        <section className="tp-detail-section">
          <h3 className="tp-detail-heading">Identity</h3>
          <div className="tp-detail-fields">
            <Field
              label="Seniority"
              value={contact.seniorityLevel ? SENIORITY_LABELS[contact.seniorityLevel] : "—"}
            />
            <Field label="Department" value={contact.department ?? "—"} />
            <Field label="Location" value={location} />
            <Field label="Outreach" value={contact.outreachStatus.replace(/_/g, " ")} />
          </div>
        </section>

        <section className="tp-detail-section">
          <h3 className="tp-detail-heading">Contact data</h3>
          <div className="tp-detail-fields">
            <div className="tp-detail-field">
              <span className="tp-detail-label">Email</span>
              <span className="tp-detail-value">
                <span
                  className={`tp-glyph tp-glyph--${glyph.tone}`}
                  title={glyph.label}
                  aria-label={glyph.label}
                >
                  {glyph.mark}
                </span>
                {maskedEmail(contact)}
                <span className="tp-detail-meta">{EMAIL_STATUS_LABELS[contact.emailStatus]}</span>
              </span>
            </div>
            <Field label="Phone" value={contact.hasPhone ? "🔒 masked" : "—"} />
          </div>
        </section>

        <section className="tp-detail-section">
          <h3 className="tp-detail-heading">Lead score</h3>
          <ScorePanel contactId={contact.id} />
        </section>
      </div>

      <footer className="tp-slideover-foot">
        {contact.isRevealed ? (
          <button
            className="app-button"
            type="button"
            onClick={() => setRevealType("full_profile")}
            title="Already owned in this workspace — re-reveal is free"
          >
            View revealed data
          </button>
        ) : (
          <button
            className="app-button"
            type="button"
            onClick={() => setRevealType("full_profile")}
          >
            Reveal
          </button>
        )}
      </footer>

      {revealType !== null && (
        <RevealDialog
          contact={contact}
          revealType={revealType}
          onClose={() => setRevealType(null)}
          onRevealed={onRevealed}
        />
      )}
    </aside>
  );
}
