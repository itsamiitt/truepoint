// useOrganization.ts — view state for the Tenant ▸ Organization surface: loads the organization identity, the
// tenant's workspaces, and a members-directory summary together, exposing one loading/error pair, a `reload`,
// and a save() for the org form. Presentation state only; typed fetches live in api.ts. When a route isn't
// built the value reports it (org null / feed.available false) so the panel degrades to disabled/empty states.
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchMembersSummary,
  fetchOrganization,
  fetchWorkspaces,
  saveOrganization,
} from "../api";
import type { MembersSummary, Organization, WorkspacesFeed } from "../types";

export function useOrganization() {
  const [org, setOrg] = useState<Organization | null>(null);
  const [orgAvailable, setOrgAvailable] = useState(true);
  const [workspaces, setWorkspaces] = useState<WorkspacesFeed | null>(null);
  const [members, setMembers] = useState<MembersSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [o, w, m] = await Promise.all([
        fetchOrganization(),
        fetchWorkspaces(),
        fetchMembersSummary(),
      ]);
      setOrg(o);
      setOrgAvailable(o != null);
      setWorkspaces(w);
      setMembers(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load organization settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(async (patch: Partial<Organization>): Promise<boolean> => {
    const { ok } = await saveOrganization(patch);
    return ok;
  }, []);

  return { org, orgAvailable, workspaces, members, error, loading, reload, save };
}
