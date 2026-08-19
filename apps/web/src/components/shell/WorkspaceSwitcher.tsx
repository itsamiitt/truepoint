// WorkspaceSwitcher.tsx — the pinned-bottom workspace control (11 §3). Lists the workspaces the signed-in
// user can reach (GET /api/v1/workspaces) and shows the active one (from the session). Selecting another
// calls authClient.switchWorkspace, which rotates the session + reloads the shell so every per-workspace
// surface re-fetches. The command palette opens it via a window "command:switch-workspace" event.
"use client";

import { fetchWithAuth, switchWorkspace } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { sharedKeys } from "@/lib/queryKeys";
import { getSessionProbe } from "@/lib/sessionProbe";
import type { WorkspaceRole } from "@leadwolf/types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import styles from "./WorkspaceSwitcher.module.css";

interface WorkspaceOption {
  id: string;
  name: string;
  role: WorkspaceRole;
}

export function WorkspaceSwitcher() {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // The workspace LIST is a query, not a raw useEffect fetch (perf-audit P3.5): cached across remounts and
  // hard loads (switching rotates the session + reloads the shell, so a 5-minute staleTime cannot go stale
  // in practice). The ACTIVE id still comes from the shared session probe — single-flight, usually already
  // resolved by the shell — so mounting here never re-requests /auth/session.
  const workspacesQuery = useQuery({
    queryKey: sharedKeys.workspaces(),
    queryFn: async (): Promise<WorkspaceOption[]> => {
      const res = await fetchWithAuth(`${API_BASE}/api/v1/workspaces`);
      if (!res.ok) throw new Error(`workspaces read failed (${res.status})`);
      const list = (await res.json()) as { workspaces: WorkspaceOption[] };
      return list.workspaces;
    },
    staleTime: 5 * 60_000,
  });
  const workspaces = workspacesQuery.data ?? [];

  useEffect(() => {
    let live = true;
    void getSessionProbe().then((probed) => {
      if (live && probed.ok) setActiveId(probed.session.workspaceId);
    });
    return () => {
      live = false;
    };
  }, []);

  // The command palette opens this control via a window event (decoupled — no shared module import).
  useEffect(() => {
    const onOpen = () => {
      setSwitchError(null);
      setOpen(true);
    };
    window.addEventListener("command:switch-workspace", onOpen);
    return () => window.removeEventListener("command:switch-workspace", onOpen);
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

  const active = workspaces.find((w) => w.id === activeId) ?? null;
  const label = workspacesQuery.isPending
    ? "Loading…"
    : (active?.name ?? (activeId ? `Workspace ${activeId.slice(0, 8)}` : "No workspace"));

  // switchWorkspace reloads the page on success; on a non-2xx it throws ("switch_failed"). Catch here so the
  // failure surfaces inline instead of dead-ending as an unhandled rejection that silently strands the user.
  async function select(id: string) {
    if (id === activeId) {
      setOpen(false);
      return;
    }
    setSwitchError(null);
    try {
      await switchWorkspace(id);
    } catch {
      setSwitchError("Couldn’t switch workspace. Try again.");
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
        // biome-ignore lint/a11y/useSemanticElements: listbox is an ARIA composite widget with no native HTML element.
        <div className={styles.menu} role="listbox" aria-label="Switch workspace" tabIndex={-1}>
          {workspacesQuery.isPending && <p className={styles.state}>Loading workspaces…</p>}
          {workspacesQuery.isError && <p className={styles.state}>Couldn’t load workspaces.</p>}
          {switchError && <p className={styles.state}>{switchError}</p>}
          {workspacesQuery.isSuccess && workspaces.length === 0 && (
            <p className={styles.state}>No workspaces.</p>
          )}
          {workspacesQuery.isSuccess &&
            workspaces.map((w) => (
              <button
                key={w.id}
                className={styles.option}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: option is an ARIA composite-widget role with no native HTML element.
                role="option"
                aria-selected={w.id === activeId}
                onClick={() => void select(w.id)}
              >
                <span className={styles.optionName}>{w.name}</span>
                <span className={styles.optionRole}>{w.role}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
