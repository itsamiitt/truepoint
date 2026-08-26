// Panel.tsx — the Profile Intelligence Panel shell (chrome-extension/08 §3.2, X06 remainder).
//
// TWO TABS, deliberately: Prospect and Company. The previous five-tab row shipped three tabs that rendered an
// EmptyState and nothing else — advertising Lists, Sequences and AI the product does not have (and two of
// which are explicit non-goals). A tab that cannot answer is worse than no tab, so they are gone; the Reveal
// tab's job now lives inside the Prospect tab's contact card, where the person it concerns is.
//
// The panel is a THIN CLIENT (architecture rule 1): it holds no token, makes no HTTP call, and owns no
// business logic. It sends bus messages and renders the typed result, with all four states wired.
import { useCallback, useEffect, useId, useRef, useState } from "react";
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
  ink3,
  ink4,
  surface,
  surface3,
} from "./primitives.tsx";
import { useIntel, usePanelSubject } from "./useIntel.ts";

type Tab = "prospect" | "company";

/** Tab order is the keyboard order: ArrowLeft/Right walk this array, Home/End jump to its ends. */
const TABS: readonly Tab[] = ["prospect", "company"] as const;

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
    // The inactive label is TEXT, not decoration: --tp-ink-4 is 2.54:1 and fails AA, so it reads ink3.
    color: active ? ink : ink3,
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: "pointer",
  };
}

/** The list fetch, as a state a render can read. `null` conflated "not asked yet" with "failed" — see below. */
type ListsState =
  | { phase: "loading" }
  | { phase: "ready"; lists: ListSummary[] }
  | { phase: "error" };

/**
 * The add-to-list picker: opened on demand, so a panel that never uses it never fetches lists.
 *
 * It is a real MENU, not a div that appears. The popover owns the focus while it is open (focus enters on
 * open, ArrowUp/Down walk the items, Escape closes it and puts focus back on the trigger it came from), a
 * pointerdown anywhere else dismisses it, and the trigger announces both what it opens and whether it is
 * open. Without that a keyboard user could open this and have no way back out of it.
 *
 * The fetch has a .catch. `send()` is `chrome.runtime.sendMessage`, which REJECTS when the service worker
 * is not there to answer — and an unhandled rejection left this pinned on "Loading…" with no way to retry.
 */
function AddToList({
  contactId,
  onDone,
}: {
  contactId: string;
  onDone: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<ListsState>({ phase: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const labelId = useId();

  const load = useCallback((): void => {
    setLists({ phase: "loading" });
    void send({ type: "LIST_LISTS" })
      .then((r) => setLists({ phase: "ready", lists: r.lists ?? [] }))
      .catch(() => setLists({ phase: "error" }));
  }, []);

  /** Closing always hands focus back: a popover that swallows the caret is a keyboard dead end. */
  const close = useCallback((): void => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // pointerdown, not click, and on the capture phase: a press that starts outside dismisses the menu without
  // first activating whatever it landed on.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const rowCount = lists.phase === "ready" ? lists.lists.length : 0;

  // Focus enters on open, and again when the rows finally arrive — at the moment of opening there is nothing
  // to focus yet, so the container takes it and Escape still has somewhere to fire from.
  useEffect(() => {
    if (!open) return;
    const first =
      rowCount > 0
        ? itemsRef.current.find((el): el is HTMLButtonElement => el !== null)
        : undefined;
    (first ?? popoverRef.current)?.focus();
  }, [open, rowCount]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const focusable = itemsRef.current.filter((el): el is HTMLButtonElement => el !== null);
    if (focusable.length === 0) return;
    // preventDefault so ArrowUp/Down move the selection instead of scrolling the panel behind the menu.
    e.preventDefault();
    const last = focusable.length - 1;
    const at = focusable.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? last
          : at === -1
            ? e.key === "ArrowDown"
              ? 0
              : last
            : e.key === "ArrowDown"
              ? (at + 1) % focusable.length
              : (at + last) % focusable.length;
    focusable[next]?.focus();
  };

  const add = async (listId: string): Promise<void> => {
    if (busy !== null) return;
    setBusy(listId);
    setError(null);
    const res = await send({ type: "ADD_TO_LIST", listId, contactId });
    setBusy(null);
    if (!res.ok) {
      // A viewer-role member gets a permission error, not a silent no-op.
      setError(t(`error.${res.errorClass ?? "unexpected"}` as Parameters<typeof t>[0]));
      return;
    }
    close();
    onDone();
  };

  return (
    <>
      <Button
        variant="ghost"
        buttonRef={triggerRef}
        hasPopup="menu"
        expanded={open}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          setOpen(true);
          if (lists.phase !== "ready") load();
        }}
      >
        {t("footer.addToList")}
      </Button>
      {open ? (
        <div
          ref={popoverRef}
          // The container is the key surface AND the focus of last resort while the rows are still in flight.
          tabIndex={-1}
          onKeyDown={onKeyDown}
          style={{
            position: "absolute",
            bottom: 52,
            left: 12,
            right: 12,
            background: surface,
            border: `1px solid ${hairline2}`,
            borderRadius: "var(--radius, 8px)",
            boxShadow:
              "var(--tp-shadow-popover, 0 4px 16px rgba(17,24,39,0.08), 0 1px 3px rgba(17,24,39,0.06))",
            padding: 10,
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span id={labelId} style={{ fontSize: 12, fontWeight: 600 }}>
              {t("footer.addToList")}
            </span>
            <Button variant="ghost" onClick={close}>
              {t("footer.close")}
            </Button>
          </div>
          {lists.phase === "loading" ? (
            <Muted>{t("state.loading")}</Muted>
          ) : lists.phase === "error" ? (
            // The whole point of the .catch: a failed fetch is a state with a way out of it.
            <ErrorBlock
              title={t("error.unexpected")}
              onRetry={load}
              retryLabel={t("panel.retry")}
            />
          ) : lists.lists.length === 0 ? (
            <Muted>{t("footer.noLists")}</Muted>
          ) : (
            <div role="menu" aria-labelledby={labelId}>
              {lists.lists.map((l, i) => (
                <button
                  key={l.id}
                  type="button"
                  ref={(el) => {
                    itemsRef.current[i] = el;
                  }}
                  // aria-disabled rather than `disabled`: a disabled button drops out of the focus order, and
                  // losing focus mid-menu would strand the caret while the request is in flight.
                  aria-disabled={busy !== null}
                  onClick={() => void add(l.id)}
                  // Roving tabindex — the menu itself is what the caret entered, and arrows walk the rows.
                  tabIndex={-1}
                  role="menuitem"
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
                    fontSize: 13,
                    color: ink2,
                    textAlign: "left",
                    opacity: busy !== null && busy !== l.id ? 0.5 : 1,
                    cursor: busy !== null ? "default" : "pointer",
                  }}
                >
                  <span>{l.name}</span>
                  <span style={{ color: ink3 }}>{l.memberCount}</span>
                </button>
              ))}
            </div>
          )}
          {error ? (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--danger-700, #b91c1c)" }}>
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function Panel(): React.ReactElement {
  const [tab, setTab] = useState<Tab>("prospect");
  const [state, setState] = useState<AppState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const subject = usePanelSubject();
  const { state: intelState, recapture, refresh } = useIntel(subject);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const panelId = useId();
  const tabId = (name: Tab): string => `${panelId}-${name}`;

  // The other half of a roving tabindex. Taking the inactive tab out of the tab order is only correct if the
  // arrow keys can still reach it; ship the tabindex alone and the second tab becomes unreachable by keyboard
  // entirely (WCAG 2.2 SC 2.1.1). Selection FOLLOWS focus, which is the pattern for a small set of tabs whose
  // content is already in hand — nothing is fetched by moving between them.
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    const at = TABS.indexOf(tab);
    const next =
      e.key === "ArrowRight"
        ? TABS[(at + 1) % TABS.length]
        : e.key === "ArrowLeft"
          ? TABS[(at + TABS.length - 1) % TABS.length]
          : e.key === "Home"
            ? TABS[0]
            : e.key === "End"
              ? TABS[TABS.length - 1]
              : undefined;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };

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
      return (
        <EmptyBlock title={t("prospect.emptyOnCompany")} hint={t("prospect.emptyOnCompanyHint")} />
      );
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
              // An ENABLED icon is the control's only visual, so it owes 3:1 (SC 1.4.11) and ink4 is 2.54:1.
              // Disabled controls are exempt from that minimum, and this is the one place ink4 belongs.
              color: subject ? ink3 : ink4,
              cursor: subject ? "pointer" : "default",
              fontSize: 13,
            }}
          >
            ↻
          </button>
        </div>
      </div>

      <div
        role="tablist"
        aria-label={t("panel.tabsLabel")}
        style={{ display: "flex", gap: 2, padding: "0 18px 12px", flex: "none" }}
      >
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            id={tabId(name)}
            ref={(el) => {
              tabRefs.current[name] = el;
            }}
            onClick={() => setTab(name)}
            onKeyDown={onTabKeyDown}
            style={tabStyle(tab === name)}
            tabIndex={tab === name ? 0 : -1}
            aria-controls={panelId}
            aria-selected={tab === name}
            role="tab"
          >
            {t(`tab.${name}` as Parameters<typeof t>[0])}
          </button>
        ))}
      </div>

      <div
        id={panelId}
        aria-labelledby={tabId(tab)}
        role="tabpanel"
        style={{ flex: 1, overflowY: "auto", padding: "4px 18px 20px" }}
      >
        {body()}
      </div>

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
          <span style={{ flex: 1, fontSize: 12, color: ink3 }}>
            {subject?.kind === "company" ? t("footer.companyNote") : ""}
          </span>
        ) : saved ? (
          <span
            style={{
              flex: 1,
              fontSize: 12,
              fontWeight: 600,
              color: "var(--success, #16a34a)",
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
