"use client";
// TeamSwitcher.tsx — selects the active department/team (11 §1, M15). Renders nothing unless the workspace has
// teams (empty-safe — the /teams backend is an M15 seam), persists the active team, and broadcasts
// "team:changed". The full persona-aware behavior is wired by the X8 cross-cutting unit; this is the slot.
import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { DropdownMenu, Icon } from "@leadwolf/ui";
import { ChevronsUpDown } from "lucide-react";
import { useEffect, useState } from "react";

interface Team {
  id: string;
  name: string;
}

const STORAGE_KEY = "tp-active-team";

export function TeamSwitcher() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`${API_BASE}/api/v1/teams`);
        if (!res.ok) return;
        const data = (await res.json()) as { teams?: Team[] } | Team[];
        const list = Array.isArray(data) ? data : (data.teams ?? []);
        if (!cancelled) setTeams(list);
      } catch {
        // Teams are an M15 seam; absence is expected — stay silent and render nothing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) setActiveId(saved);
  }, []);

  if (teams.length === 0) return null;

  const active = teams.find((t) => t.id === activeId) ?? teams[0];

  const choose = (id: string) => {
    setActiveId(id);
    window.localStorage.setItem(STORAGE_KEY, id);
    window.dispatchEvent(new CustomEvent("team:changed", { detail: { id } }));
  };

  return (
    <DropdownMenu
      align="start"
      side="top"
      trigger={({ toggle, open }) => (
        <button type="button" className="tp-ws-switcher" onClick={toggle} aria-expanded={open}>
          <span className="tp-ws-name">{active?.name ?? "Team"}</span>
          <Icon icon={ChevronsUpDown} size={14} className="tp-ws-caret" />
        </button>
      )}
      items={teams.map((t) => ({ label: t.name, onSelect: () => choose(t.id) }))}
    />
  );
}
