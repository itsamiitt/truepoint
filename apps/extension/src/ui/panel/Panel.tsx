// Panel.tsx — the Profile Intelligence Panel shell (chrome-extension/08 §3.2, X06 remainder).
//
// TWO TABS, deliberately: Prospect and Company. The previous five-tab row shipped three tabs that rendered an
// EmptyState and nothing else — advertising Lists, Sequences and AI the product does not have (and two of
// which are explicit non-goals). A tab that cannot answer is worse than no tab, so they are gone; the Reveal
// tab's job now lives inside the Prospect tab's contact card, where the person it concerns is.
//
// The panel is a THIN CLIENT (architecture rule 1): it holds no token, makes no HTTP call, and owns no
// business logic. It sends bus messages and renders the typed result, with all four states wired.
import { useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { onBroadcast, send } from "../../shared/client.ts";
import { ENV } from "../../shared/env.ts";
import type { AppState, ListSummary } from "../../shared/messages.ts";
import { CreditsPill } from "../brand/CreditsPill.tsx";
import { Lockup } from "../brand/Mark.tsx";
import { CompanyTab } from "./CompanyTab.tsx";
import { ProspectTab } from "./ProspectTab.tsx";
import {
  Button,
  EmptyBlock,
  ErrorBlock,
  Muted,
  hairline,
  hairline2,
  ink,
  ink2,
  ink4,
  surface,
  surface3,
} from "./primitives.tsx";
import { useIntel, usePanelSubject } from "./useIntel.ts";

type Tab = "prospect" | "company";

const shell: React.CSSProperties = {
  fontFamily: "var(--font-sans, system-ui)",
  color: ink,
  background: surface,
  height: "100vh",
  display: "flex",
  flexDirection: "column",
};

function tabStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: "8px 0",
    minHeight: 34,
    background: active ? surface3 : "transparent",
    border: "none",
    borderRadius: 999,
    color: active ? ink : ink4,
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: "pointer",
  };
}

/** The add-to-list picker: opened on demand, so a panel that never uses it never fetches lists. */
function AddToList({
  contactId,
  onDone,
}: {
  contactId: string;
  onDone: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || lists) return;
    void send({ type: "LIST_LISTS" }).then((r) => setLists(r.lists));
  }, [open, lists]);

  const add = async (listId: string): Promise<void> => {
    setBusy(listId);
    setError(null);
    const res = await send({ type: "ADD_TO_LIST", listId, contactId });
    setBusy(null);
    if (!res.ok) {
      // A viewer-role member gets a permission error, not a silent no-op.
      setError(t(`error.${res.errorClass ?? "unexpected"}` as Parameters<typeof t>[0]));
      return;
    }
    setOpen(false);
    onDone();
  };

  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        {t("footer.addToList")}
      </Button>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        bottom: 52,
        left: 12,
        right: 12,
        background: surface,
        border: `1px solid ${hairline2}`,
        borderRadius: "var(--radius, 8px)",
        boxShadow: "var(--tp-shadow-popover, 0 8px 24px rgba(0,0,0,0.12))",
        padding: 10,
        maxHeight: 240,
        overflowY: "auto",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{t("footer.addToList")}</span>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {t("footer.close")}
        </Button>
      </div>
      {lists === null ? (
        <Muted>{t("state.loading")}</Muted>
      ) : lists.length === 0 ? (
        <Muted>{t("footer.noLists")}</Muted>
      ) : (
        lists.map((l) => (
          <button
            key={l.id}
            type="button"
            disabled={busy !== null}
            onClick={() => void add(l.id)}
            style={{
              width: "100%",
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              minHeight: 44,
              padding: "8px 0",
              background: "none",
              border: "none",
              borderBottom: `1px solid ${hairline}`,
              fontFamily: "inherit",
              fontSize: 12.5,
              color: ink2,
              textAlign: "left",
              cursor: busy ? "default" : "pointer",
            }}
          >
            <span>{l.name}</span>
            <span style={{ color: ink4 }}>{l.memberCount}</span>
          </button>
        ))
      )}
      {error ? (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--danger-ink, #b91c1c)" }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function Panel(): React.ReactElement {
  const [tab, setTab] = useState<Tab>("prospect");
  const [state, setState] = useState<AppState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const subject = usePanelSubject();
  const { state: intelState, recapture, refresh } = useIntel(subject);

  useEffect(() => {
    void send({ type: "GET_STATE" }).then(setState);
    return onBroadcast((msg) => {
      if (msg.type === "STATE_CHANGED") setState(msg.state);
    });
  }, []);

  // A company page opens on the Company tab; a profile opens on Prospect. Following the subject rather than
  // remembering the last tab is right here: the panel's job is to describe what is on screen.
  useEffect(() => {
    if (subject) setTab(subject.kind === "company" ? "company" : "prospect");
    setSaved(false);
  }, [subject]);

  const payload = intelState.phase === "ready" ? intelState.payload : null;
  const loading = intelState.phase === "loading";
  const signedIn = state?.auth.status === "signed_in";

  const save = async (): Promise<void> => {
    if (!payload) return;
    setSaving(true);
    // Two paths, one button: a person the platform already holds is MATERIALIZED (no page read at all); a
    // person we have never seen is captured from the visible page the user opened.
    const res =
      payload.intel.status === "in_database" && subject
        ? await send({ type: "ADD_FROM_DATABASE", url: subject.sourceUrl })
        : await send({ type: "CAPTURE_CURRENT" });
    setSaving(false);
    if (res.status.outcome !== "rejected") {
      setSaved(true);
      refresh();
    }
  };

  const body = (): React.ReactElement => {
    // Signed out is not an error, and it is the FIRST thing a new install shows. Falling through to the
    // generic error block gave it "Please sign in again" over a Retry button that could never succeed —
    // the one action that helps is the one the popup offers, so the panel offers it too.
    if (state && !signedIn) {
      return (
        <div style={{ padding: "40px 0", textAlign: "center" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            {t("panel.signedOut")}
          </div>
          <Muted>{t("panel.signedOutHint")}</Muted>
          <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}>
            <Button variant="primary" onClick={() => void send({ type: "AUTH_LOGIN" })}>
              {t("popup.signIn")}
            </Button>
          </div>
        </div>
      );
    }
    if (!subject) {
      return <EmptyBlock title={t("panel.noSubject")} hint={t("panel.noSubjectHint")} />;
    }
    if (intelState.phase === "error") {
      return (
        <ErrorBlock
          title={t("panel.errorTitle")}
          detail={t(`error.${intelState.errorClass}` as Parameters<typeof t>[0])}
          onRetry={recapture}
          retryLabel={t("panel.retry")}
        />
      );
    }
    if (tab === "company") {
      return <CompanyTab payload={payload} loading={loading} />;
    }
    if (subject.kind === "company" && !loading) {
      // A company page has no person to describe — say so rather than rendering an empty person card.
      return <EmptyBlock title={t("prospect.emptyOnCompany")} hint={t("prospect.emptyOnCompanyHint")} />;
    }
    return <ProspectTab payload={payload} loading={loading} onChanged={refresh} />;
  };

  const canAddToList = Boolean(payload?.intel.contactId);
  const savedCompany = payload?.intel.company?.company.name;
  // Save is a PERSON action. There is no company-save path and that is a decision, not a gap: the content
  // script deliberately extracts nothing from a company page (X07), and "gesture-gated Save company" was
  // weighed and skipped for v1 (market-intelligence D-7). Rendering the button on a company page would give
  // it one outcome — rejected — so the footer offers what the surface can actually do.
  const canSave = Boolean(payload) && subject?.kind === "person";

  return (
    <div style={shell}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "13px 18px 12px",
          flex: "none",
        }}
      >
        <Lockup markSize={15} wordSize={13} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {signedIn ? <CreditsPill credits={state?.auth.credits ?? null} compact /> : null}
          <button
            type="button"
            title={t("footer.recapture")}
            aria-label={t("footer.recapture")}
            onClick={recapture}
            disabled={!subject}
            style={{
              width: 28,
              height: 28,
              display: "grid",
              placeItems: "center",
              border: "none",
              background: "none",
              borderRadius: "var(--tp-radius-sm, 6px)",
              color: ink4,
              cursor: subject ? "pointer" : "default",
              fontSize: 13,
            }}
          >
            ↻
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 2, padding: "0 18px 12px", flex: "none" }}>
        <button type="button" style={tabStyle(tab === "prospect")} onClick={() => setTab("prospect")}>
          {t("tab.prospect")}
        </button>
        <button type="button" style={tabStyle(tab === "company")} onClick={() => setTab("company")}>
          {t("tab.company")}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 18px 20px" }}>{body()}</div>

      <div
        style={{
          position: "relative",
          flex: "none",
          borderTop: `1px solid ${hairline}`,
          padding: "11px 18px",
          display: "flex",
          gap: 7,
          alignItems: "center",
        }}
      >
        {!canSave && !saved ? (
          <span style={{ flex: 1, fontSize: 12, color: ink4 }}>
            {subject?.kind === "company" ? t("footer.companyNote") : ""}
          </span>
        ) : saved ? (
          <span
            style={{
              flex: 1,
              fontSize: 12,
              fontWeight: 600,
              color: "var(--success, #059669)",
            }}
          >
            {/* "Saved · <Company> linked" only when we can SEE the link — the from-database response carries
                no account id, so claiming it unconditionally would sometimes be a lie. */}
            {savedCompany
              ? t("footer.savedLinked").replace("{company}", savedCompany)
              : t("footer.saved")}
          </span>
        ) : (
          <span style={{ flex: 1 }}>
            <Button
              variant="primary"
              full
              busy={saving}
              disabled={payload?.intel.status === "found"}
              onClick={() => void save()}
            >
              {payload?.intel.status === "found" ? t("footer.inWorkspace") : t("footer.save")}
            </Button>
          </span>
        )}
        {canAddToList && payload?.intel.contactId ? (
          <AddToList contactId={payload.intel.contactId} onDone={refresh} />
        ) : null}
        <Button
          variant="ghost"
          onClick={() => window.open(ENV.appOrigin, "_blank", "noopener,noreferrer")}
        >
          {t("footer.dashboard")}
        </Button>
      </div>
    </div>
  );
}
