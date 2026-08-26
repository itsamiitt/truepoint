// OrgSwitcher.tsx — the pinned-bottom ORGANIZATION (tenant) control (Issue 2b). Lists the orgs the signed-in
// user belongs to (GET auth.*/orgs) and shows the active one. Selecting another calls authClient.switchOrg,
// which re-pins the session to that org's remembered/default workspace, rotates the session + reloads the shell
// so every scoped surface re-fetches. Renders NOTHING for a single-org user — there is nothing to switch.
// Mirrors WorkspaceSwitcher (shared layout-only styles + the tp-ws-switcher class).
"use client";

import { listOrgs, switchOrg } from "@/lib/authClient";
import { sharedKeys } from "@/lib/queryKeys";
import { TpButton } from "@leadwolf/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import styles from "./WorkspaceSwitcher.module.css";

export function OrgSwitcher() {
  const [open, setOpen] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // A query, not a raw useEffect fetch (perf-audit P3.5 — the project's own state-and-data rule): the org
  // list used to re-fetch on every hard load for a control most users never see (single-org → renders
  // nothing). Cached hard: membership changes rarely, and switching reloads the whole shell anyway.
  const orgsQuery = useQuery({
    queryKey: sharedKeys.orgs(),
    queryFn: listOrgs,
    staleTime: 5 * 60_000,
  });
  const orgs = orgsQuery.data?.orgs ?? [];
  const activeId = orgsQuery.data?.activeTenantId ?? null;

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
  if (!orgsQuery.isSuccess || orgs.length < 2) return null;

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
      {/* The DS button base wearing the shared `tp-ws-switcher` skin, which is declared after
          primitives.css in globals.css and so still owns the geometry (34px, full width, 7px radius). */}
      <TpButton
        variant="secondary"
        className="tp-ws-switcher"
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
      </TpButton>

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
