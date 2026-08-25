"use client";
// TeamSwitcher.tsx — selects the active department/team (11 §1, M15). Renders nothing unless the workspace has
// teams (empty-safe — the /teams backend is an M15 seam), persists the active team, and broadcasts
// "team:changed". The full persona-aware behavior is wired by the X8 cross-cutting unit; this is the slot.
import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { sharedKeys } from "@/lib/queryKeys";
import { DropdownMenu, Icon, TpButton } from "@leadwolf/ui";
import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown } from "lucide-react";
import { useEffect, useState } from "react";

interface Team {
  id: string;
  name: string;
}

const STORAGE_KEY = "tp-active-team";

export function TeamSwitcher() {
  const [activeId, setActiveId] = useState<string | null>(null);

  // A query, not a raw useEffect fetch (perf-audit P3.5): the team list re-fetched on every hard load for a
  // control that renders nothing until the M15 backend exists. The queryFn swallows everything — teams are a
  // seam and absence is expected, exactly the prior silent posture — so there is nothing to retry either.
  const teamsQuery = useQuery({
    queryKey: sharedKeys.teams(),
    queryFn: async (): Promise<Team[]> => {
      try {
        const res = await fetchWithAuth(`${API_BASE}/api/v1/teams`);
        if (!res.ok) return [];
        const data = (await res.json()) as { teams?: Team[] } | Team[];
        return Array.isArray(data) ? data : (data.teams ?? []);
      } catch {
        return [];
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  const teams = teamsQuery.data ?? [];

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
      // `props` is spread rather than re-deriving aria-expanded by hand: the DS also supplies
      // aria-haspopup="menu" and aria-controls, both of which the hand-written trigger dropped.
      trigger={({ toggle, props }) => (
        <TpButton variant="secondary" className="tp-ws-switcher" onClick={toggle} {...props}>
          <span className="tp-ws-name">{active?.name ?? "Team"}</span>
          <Icon icon={ChevronsUpDown} size={14} className="tp-ws-caret" />
        </TpButton>
      )}
      items={teams.map((t) => ({ label: t.name, onSelect: () => choose(t.id) }))}
    />
  );
}
