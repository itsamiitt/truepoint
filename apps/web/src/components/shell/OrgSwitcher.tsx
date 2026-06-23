// OrgSwitcher.tsx — the pinned-bottom ORGANIZATION (tenant) control (Issue 2b). Lists the orgs the signed-in
// user belongs to (GET auth.*/orgs) and shows the active one. Selecting another calls authClient.switchOrg,
// which re-pins the session to that org's remembered/default workspace, rotates the session + reloads the shell
// so every scoped surface re-fetches. Renders NOTHING for a single-org user — there is nothing to switch.
// Mirrors WorkspaceSwitcher (shared layout-only styles + the tp-ws-switcher class).
"use client";

import { type OrgOption, listOrgs, switchOrg } from "@/lib/authClient";
import { useEffect, useRef, useState } from "react";
import styles from "./WorkspaceSwitcher.module.css";

type LoadState = "loading" | "ready" | "error";

export function OrgSwitcher() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>("loading");
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { orgs: list, activeTenantId } = await listOrgs();
        setOrgs(list);
        setActiveId(activeTenantId);
        setState("ready");
      } catch {
        setState("error");
      }
    })();
  }, []);

  // Dismiss on outside click + Escape so the pop-up never traps focus or lingers.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A single-org user has nothing to switch — render nothing (and never while still loading the list).
  if (state !== "ready" || orgs.length < 2) return null;

  const active = orgs.find((o) => o.tenantId === activeId) ?? null;
  const label = active?.tenantName ?? "Organization";

  // switchOrg reloads the page on success; on a non-2xx it throws ("switch_failed"). Catch here so the failure
  // surfaces inline instead of dead-ending as an unhandled rejection that silently strands the user.
  async function select(id: string) {
    if (id === activeId) {
      setOpen(false);
      return;
    }
    setSwitchError(null);
    try {
      await switchOrg(id);
    } catch {
      setSwitchError("Couldn’t switch organization. Try again.");
      setOpen(true);
    }
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        className="tp-ws-switcher"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() =>
          setOpen((v) => {
            if (!v) setSwitchError(null); // reopening clears any stale failure from a prior attempt
            return !v;
          })
        }
      >
        <span className="tp-ws-name">{label}</span>
        <span className="tp-ws-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        // biome-ignore lint/a11y/useSemanticElements: listbox is an ARIA composite widget with no native element.
        <div className={styles.menu} role="listbox" aria-label="Switch organization" tabIndex={-1}>
          {switchError && <p className={styles.state}>{switchError}</p>}
          {orgs.map((o) => (
            <button
              key={o.tenantId}
              className={styles.option}
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: option is an ARIA composite-widget role, no native element.
              role="option"
              aria-selected={o.tenantId === activeId}
              onClick={() => void select(o.tenantId)}
            >
              <span className={styles.optionName}>{o.tenantName}</span>
              {o.isTenantOwner && <span className={styles.optionRole}>owner</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
