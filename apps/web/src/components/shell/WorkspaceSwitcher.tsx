// WorkspaceSwitcher.tsx — the pinned-bottom workspace control (11 §3). Lists the workspaces the signed-in
// user can reach (GET /api/v1/workspaces) and shows the active one (from the session). Selecting another
// calls authClient.switchWorkspace, which rotates the session + reloads the shell so every per-workspace
// surface re-fetches. The command palette opens it via a window "command:switch-workspace" event.
"use client";

import { fetchWithAuth, switchWorkspace } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { WorkspaceRole } from "@leadwolf/types";
import { useEffect, useRef, useState } from "react";
import styles from "./WorkspaceSwitcher.module.css";

interface WorkspaceOption {
  id: string;
  name: string;
  role: WorkspaceRole;
}

type LoadState = "loading" | "ready" | "error";

export function WorkspaceSwitcher() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>("loading");
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [listRes, sessionRes] = await Promise.all([
          fetchWithAuth(`${API_BASE}/api/v1/workspaces`),
          fetchWithAuth(`${API_BASE}/api/v1/auth/session`),
        ]);
        if (!listRes.ok) {
          setState("error");
          return;
        }
        const list = (await listRes.json()) as { workspaces: WorkspaceOption[] };
        setWorkspaces(list.workspaces);
        if (sessionRes.ok) {
          const session = (await sessionRes.json()) as { workspaceId: string | null };
          setActiveId(session.workspaceId);
        }
        setState("ready");
      } catch {
        setState("error");
      }
    })();
  }, []);

  // The command palette opens this control via a window event (decoupled — no shared module import).
  useEffect(() => {
    const onOpen = () => setOpen(true);
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
  const label =
    state === "loading"
      ? "Loading…"
      : (active?.name ?? (activeId ? `Workspace ${activeId.slice(0, 8)}` : "No workspace"));

  function select(id: string) {
    setOpen(false);
    if (id === activeId) return;
    void switchWorkspace(id);
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        className="tp-ws-switcher"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tp-ws-name">{label}</span>
        <span className="tp-ws-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        // biome-ignore lint/a11y/useSemanticElements: listbox is an ARIA composite widget with no native HTML element.
        <div className={styles.menu} role="listbox" aria-label="Switch workspace" tabIndex={-1}>
          {state === "loading" && <p className={styles.state}>Loading workspaces…</p>}
          {state === "error" && <p className={styles.state}>Couldn’t load workspaces.</p>}
          {state === "ready" && workspaces.length === 0 && (
            <p className={styles.state}>No workspaces.</p>
          )}
          {state === "ready" &&
            workspaces.map((w) => (
              <button
                key={w.id}
                className={styles.option}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: option is an ARIA composite-widget role with no native HTML element.
                role="option"
                aria-selected={w.id === activeId}
                onClick={() => select(w.id)}
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
