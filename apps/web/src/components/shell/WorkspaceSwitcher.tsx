// WorkspaceSwitcher.tsx — the pinned-bottom workspace control (11 §3). Reads the active workspace from the
// session; there is no list endpoint yet (switching is post-MVP, ADR-0006), so this renders present but
// inert: a display-only control with a "Switching coming soon" tooltip. Shows the current workspace id so
// the rail always reflects the per-workspace scope the rest of the app operates under.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { useEffect, useState } from "react";

function shortWorkspace(id: string | null): string {
  if (!id) return "No workspace";
  return `Workspace ${id.slice(0, 8)}`;
}

export function WorkspaceSwitcher() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetchWithAuth(`${API_BASE}/api/v1/auth/session`);
      if (res.ok) {
        const data = (await res.json()) as { workspaceId: string | null };
        setWorkspaceId(data.workspaceId);
      }
    })();
  }, []);

  return (
    <button
      className="tp-ws-switcher"
      type="button"
      disabled
      aria-disabled="true"
      title="Switching coming soon"
    >
      <span className="tp-ws-name">{shortWorkspace(workspaceId)}</span>
      <span className="tp-ws-caret" aria-hidden="true">
        ▾
      </span>
    </button>
  );
}
