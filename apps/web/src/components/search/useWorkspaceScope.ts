// useWorkspaceScope.ts — the All / In-workspace / New-to-me scope, in the URL like everything else on this
// surface, so a shared link reproduces the view exactly.
//
// One param (`ws`) shared by both tabs on purpose. "Show me only what I don't already have" is a habit a rep
// carries across People and Accounts; making them remember it twice would be a worse surface, and the two
// query codecs stay untouched either way.
"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import {
  DEFAULT_WORKSPACE_SCOPE,
  type WorkspaceScope,
  parseWorkspaceScope,
} from "./WorkspaceScopeControl";

const PARAM = "ws";

export interface UseWorkspaceScope {
  scope: WorkspaceScope;
  setScope: (next: WorkspaceScope) => void;
  /** Should the OWNED engine run? False in "New to me". */
  includeOwned: boolean;
  /** Should the GLOBAL engine run? False in "In workspace". */
  includeDatabase: boolean;
}

export function useWorkspaceScope(): UseWorkspaceScope {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const scope = useMemo(
    () => parseWorkspaceScope(new URLSearchParams(searchParams?.toString() ?? "").get(PARAM)),
    [searchParams],
  );

  const setScope = useCallback(
    (next: WorkspaceScope) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (next === DEFAULT_WORKSPACE_SCOPE) params.delete(PARAM);
      else params.set(PARAM, next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  return {
    scope,
    setScope,
    includeOwned: scope !== "exclude",
    includeDatabase: scope !== "mine",
  };
}
