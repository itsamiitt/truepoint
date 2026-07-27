// useProfile.ts — the editable user profile (GET /settings/user/profile). Presentation state only;
// the typed fetch lives in api.ts. One hook per resource (slice pattern).
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchProfile } from "../api";
import { settingsUserKeys } from "../keys";
import type { UserProfile } from "../types";

export function useProfile() {
  const query = useQuery<UserProfile>({
    queryKey: settingsUserKeys.profile(),
    queryFn: fetchProfile,
  });

  return {
    data: query.data ?? null,
    loading: query.isPending,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load your profile"
      : null,
    reload: () => {
      void query.refetch();
    },
  };
}
