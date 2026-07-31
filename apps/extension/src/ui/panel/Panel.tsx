// Side panel (08 §3.2) — the tabbed workspace, brand-first. The header carries the TruePoint lockup + the
// live credit balance; the Captured tab reads the local `recent` store and renders all four StateSwitch states
// (loading / empty / error+retry / populated) as brand rows (mono initials + mono outcome label). Token-driven
// (04 §3): "Cobalt fills, Ink type" — the active tab is a soft Cobalt fill, everything else is ink + hairline.
import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { onBroadcast, send } from "../../shared/client.ts";
import { ENV } from "../../shared/env.ts";
import { type RecentItem, db } from "../../shared/idb.ts";
import type { AppState } from "../../shared/messages.ts";
import type { SubjectStatus } from "../../shared/types.ts";
import { CreditsPill } from "../brand/CreditsPill.tsx";
import { Lockup } from "../brand/Mark.tsx";

type Tab = "captured" | "reveal" | "lists" | "sequences" | "ai";
type Load<T> = { status: "loading" } | { status: "error" } | { status: "ready"; data: T };

const TABS: { id: Tab; labelKey: Parameters<typeof t>[0] }[] = [
  { id: "captured", labelKey: "panel.captured" },
  { id: "reveal", labelKey: "panel.reveal" },
  { id: "lists", labelKey: "panel.lists" },
  { id: "sequences", labelKey: "panel.sequences" },
  { id: "ai", labelKey: "panel.ai" },
];

const shell: React.CSSProperties = {
  fontFamily: "var(--font-sans, system-ui)",
  color: "var(--tp-ink, #111827)",
  background: "var(--tp-surface, #fff)",
  height: "100vh",
  display: "flex",
  flexDirection: "column",
};
const bar: React.CSSProperties = {
  height: 52,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 var(--tp-space-4, 16px)",
  borderBottom: "1px solid var(--tp-hairline-2, #e5e7eb)",
};
const tabsRow: React.CSSProperties = {
  display: "flex",
  gap: 4,
  padding: "8px var(--tp-space-4, 16px)",
  borderBottom: "1px solid var(--tp-hairline, #f0f0f0)",
};
const body: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "var(--tp-space-4, 16px)",
};
const muted: React.CSSProperties = { color: "var(--tp-ink-3, #6b7280)", fontSize: 13 };
const monoOutcome: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--tp-ink-4, #9ca3af)",
};

function tabStyle(active: boolean): React.CSSProperties {
  return {
    border: 0,
    background: active ? "var(--tp-cobalt-50, #e9f0fc)" : "transparent",
    color: active ? "var(--tp-cobalt-700, #1e4fa3)" : "var(--tp-ink-3, #6b7280)",
    borderRadius: "var(--tp-radius-sm, 6px)",
    padding: "5px 11px",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

/** Two-letter initials for the row avatar (mono, per the Brand-Kit lead rows). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

function EmptyState({ title, hint }: { title: string; hint: string }): React.ReactElement {
  return (
    <div style={{ textAlign: "center", padding: "40px 0" }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={muted}>{hint}</div>
    </div>
  );
}

function CapturedTab(): React.ReactElement {
  const [load, setLoad] = useState<Load<RecentItem[]>>({ status: "loading" });

  const reload = useCallback(() => {
    setLoad({ status: "loading" });
    db()
      .then((database) => database.getAll("recent"))
      .then((rows) => setLoad({ status: "ready", data: rows }))
      .catch(() => setLoad({ status: "error" }));
  }, []);

  // reload is a stable useCallback([]) — run once on mount.
  useEffect(reload, []);

  if (load.status === "loading") {
    return <div style={muted}>{t("state.loading")}</div>;
  }
  if (load.status === "error") {
    return (
      <div style={{ textAlign: "center", padding: "40px 0" }}>
        <div style={{ marginBottom: 8 }}>{t("panel.errorLoad")}</div>
        <button type="button" style={tabStyle(false)} onClick={reload}>
          {t("panel.retry")}
        </button>
      </div>
    );
  }
  if (load.data.length === 0) {
    return <EmptyState title={t("panel.emptyCaptured")} hint={t("panel.emptyCapturedHint")} />;
  }
  return (
    <div>
      {load.data.map((item) => (
        <div
          key={item.contactId}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            minHeight: 48,
            padding: "8px 0",
            borderBottom: "1px solid var(--tp-hairline, #f0f0f0)",
          }}
        >
          <span
            style={{
              width: 32,
              height: 32,
              flexShrink: 0,
              borderRadius: "50%",
              background: "var(--tp-surface-3, #f4f5f7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--tp-ink-3, #6b7280)",
            }}
          >
            {initials(item.name)}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 500,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {item.name}
            </div>
            {item.company ? (
              <div
                style={{
                  ...muted,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.company}
              </div>
            ) : null}
          </div>
          <span style={monoOutcome}>{item.outcome}</span>
        </div>
      ))}
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  width: "100%",
  border: 0,
  borderRadius: "var(--radius, 8px)",
  padding: "8px 12px",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--tp-on-fill, #fff)",
  background: "var(--tp-btn, #111827)",
  fontFamily: "inherit",
};

/** Titlecase a LinkedIn slug ("jane-doe-8a1b") into a readable label — the masked name isn't carried on the
 *  status broadcast, so the slug is the fallback identifier (richer hydration is a follow-up). */
function slugLabel(key: string): string {
  return key
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function revealError(errorClass?: string): string {
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

/** The Reveal tab — the current LinkedIn prospect's TruePoint status, driven by the SUBJECT_STATUS broadcast
 *  the service worker emits on LOOKUP (chrome-extension/14 X01/X06). Four states: no subject (open a profile) ·
 *  unknown (no match) · known-not-revealed (Reveal) · owned (Open in app). It populates when the user views a
 *  profile; on-open hydration of the active tab's subject is a follow-up. */
function RevealTab(): React.ReactElement {
  const [subject, setSubject] = useState<{ key: string; status: SubjectStatus } | null>(null);
  const [reveal, setReveal] = useState<{
    phase: "idle" | "busy" | "done" | "error";
    text?: string;
    /** Badge v0 (S-10). Carried on the response so the panel needs no second round-trip. */
    verification?: {
      lastVerifiedAt: string | null;
      sourceCount: number | null;
      sourceDiversity: number | null;
    };
  }>({
    phase: "idle",
  });

  useEffect(() => {
    return onBroadcast((msg) => {
      if (msg.type === "SUBJECT_STATUS") {
        setSubject({ key: msg.subjectKey, status: msg.status });
        setReveal({ phase: "idle" });
      }
    });
  }, []);

  if (!subject) {
    return <EmptyState title={t("panel.revealEmpty")} hint={t("panel.revealEmptyHint")} />;
  }

  const { status } = subject;
  const contactId = status.contactId;

  const onReveal = async (): Promise<void> => {
    if (!contactId) {
      return;
    }
    setReveal({ phase: "busy" });
    const res = await send({ type: "REVEAL", contactId, revealType: "email" });
    if (!res.ok) {
      setReveal({ phase: "error", text: revealError(res.errorClass) });
      return;
    }
    setReveal({
      phase: "done",
      // nothingToReveal FIRST: a record we hold no email for is not the same as a free re-reveal, and the
      // web UI had the same bug — it told users they "already owned" a contact we had nothing for (S-12).
      text: res.nothingToReveal
        ? t("card.nothingOnFile")
        : (res.email ?? res.phone ?? t("card.revealed")),
      verification: res.verification,
    });
  };

  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 14 }}>{slugLabel(subject.key)}</div>
      <div style={{ ...monoOutcome, marginTop: 4 }}>
        {status.owned
          ? t("card.revealed")
          : status.known
            ? t("card.notRevealed")
            : t("card.noMatch")}
      </div>
      <div style={{ height: 1, background: "var(--tp-hairline, #f0f0f0)", margin: "12px 0" }} />

      {status.known && contactId ? (
        status.owned ? (
          <button
            type="button"
            style={primaryBtn}
            onClick={() =>
              window.open(`${ENV.appOrigin}/prospect`, "_blank", "noopener,noreferrer")
            }
          >
            {t("card.openInApp")}
          </button>
        ) : (
          <button
            type="button"
            style={primaryBtn}
            disabled={reveal.phase === "busy"}
            onClick={() => void onReveal()}
          >
            {reveal.phase === "busy" ? t("card.revealing") : t("card.reveal")}
          </button>
        )
      ) : (
        <div style={muted}>{t("card.noMatchHint")}</div>
      )}

      {reveal.text ? (
        <div style={{ marginTop: 10, fontSize: 13, color: "var(--tp-ink, #111827)" }}>
          {reveal.text}
        </div>
      ) : null}

      {/* Confidence badge v0 (S-10): "badge visible on 100% of reveals" is the acceptance criterion, and 09
          names the same thing as a trust surface — "verified <n> days ago via <k> independent signals". */}
      {reveal.phase === "done" && reveal.verification?.lastVerifiedAt ? (
        <div style={{ ...muted, marginTop: 6 }}>{badgeLabel(reveal.verification)}</div>
      ) : null}
    </div>
  );
}

/**
 * Badge v0's text. Mirrors the web dialog exactly so the two surfaces cannot describe the same record
 * differently — a badge that disagrees with the app is worse than no badge, because the user cannot tell
 * which one is lying.
 *
 * The source clause is OMITTED when sourceCount is null, never rendered as "0 sources": null means we hold no
 * evidence log for the record, which until the provenance gate is on is true of every record. Rendering a
 * zero would stamp a misleading confidence signal across the whole database on the exact outcome (S-10) that
 * exists to make trust visible.
 */
function badgeLabel(v: {
  lastVerifiedAt: string | null;
  sourceCount: number | null;
}): string {
  const days = ageDays(v.lastVerifiedAt);
  const freshness =
    days === null
      ? t("card.notVerified")
      : days === 0
        ? t("card.verifiedToday")
        : t("card.verifiedDaysAgo").replace("{n}", String(days));
  if (v.sourceCount == null) return freshness;
  return `${freshness} · ${t("card.sources").replace("{k}", String(v.sourceCount))}`;
}

/** Whole days since an ISO timestamp; null when absent or unparseable. Floors, never negative — the same
 *  shape as @leadwolf/types' ageDaysSince, which the extension cannot import (it ships its own bundle). */
function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86_400_000));
}

export function Panel(): React.ReactElement {
  const [tab, setTab] = useState<Tab>("captured");
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    void send({ type: "GET_STATE" }).then(setState);
    return onBroadcast((msg) => {
      if (msg.type === "STATE_CHANGED") {
        setState(msg.state);
      }
    });
  }, []);

  const signedIn = state?.auth.status === "signed_in";

  return (
    <div style={shell}>
      <div style={bar}>
        <Lockup markSize={22} wordSize={16} />
        {signedIn ? <CreditsPill credits={state?.auth.credits ?? null} compact /> : null}
      </div>
      <div style={tabsRow}>
        {TABS.map((entry) => (
          <button
            type="button"
            key={entry.id}
            style={tabStyle(tab === entry.id)}
            onClick={() => setTab(entry.id)}
          >
            {t(entry.labelKey)}
          </button>
        ))}
      </div>
      <div style={body}>
        {tab === "captured" ? (
          <CapturedTab />
        ) : tab === "reveal" ? (
          <RevealTab />
        ) : (
          <EmptyState title={t("panel.emptyCaptured")} hint={t("panel.emptyCapturedHint")} />
        )}
      </div>
    </div>
  );
}
