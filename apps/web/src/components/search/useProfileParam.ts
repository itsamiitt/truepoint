// useProfileParam.ts — which profile the Search surface currently has open, read from and written to the URL.
//
// The design system forbids navigating away from a list to show a detail (open a Drawer instead), and the
// architecture wants a detail view to be shareable. Putting the open profile in a SEARCH PARAM satisfies
// both: the drawer opens over the results, the list keeps its scroll and its filters, and the URL still
// fully describes what is on screen — so a link a rep pastes into Slack opens the same profile over the same
// search.
//
// Four params, one at a time, because the four row kinds are addressed differently:
//   contact=<uuid>    a workspace contact          (owned, has an id)
//   person=<slug>     a Layer-0 person             (URL-shaped key; no Layer-0 uuid ever leaves the server)
//   account=<uuid>    a workspace account          (owned)
//   company=<domain>  a Layer-0 company            (URL-shaped key)
"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

export const PROFILE_PARAMS = ["contact", "person", "account", "company"] as const;
export type ProfileKind = (typeof PROFILE_PARAMS)[number];

export interface OpenProfile {
  kind: ProfileKind;
  key: string;
}

export interface UseProfileParam {
  profile: OpenProfile | null;
  open: (kind: ProfileKind, key: string) => void;
  close: () => void;
}

export function useProfileParam(): UseProfileParam {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const profile = useMemo(() => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    // First match wins. Two profile params at once is only reachable by hand-editing the URL, and picking
    // deterministically beats rendering two drawers or throwing.
    for (const kind of PROFILE_PARAMS) {
      const key = params.get(kind);
      if (key) return { kind, key };
    }
    return null;
  }, [searchParams]);

  const write = useCallback(
    (next: OpenProfile | null) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      for (const kind of PROFILE_PARAMS) params.delete(kind);
      if (next) params.set(next.kind, next.key);
      const qs = params.toString();
      // `replace`, not `push`: opening and closing a drawer should not stack history entries the user has
      // to unwind one row at a time. The URL still captures the view for sharing and for refresh.
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  return {
    profile,
    open: useCallback((kind: ProfileKind, key: string) => write({ kind, key }), [write]),
    close: useCallback(() => write(null), [write]),
  };
}
