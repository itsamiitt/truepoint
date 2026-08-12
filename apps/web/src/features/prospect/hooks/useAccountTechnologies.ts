// useAccountTechnologies.ts — one account's Layer-0 technology traversal for the account drawer (0108).
//
// Two separate query entries, never one: `relationship` is part of the cache key because develops and uses
// are different answers from different tables, and sharing an entry would let one overwrite the other.
"use client";

import type { AccountTechnologiesResponse, OrgTechnologyRelationship } from "@leadwolf/types";
import { useQuery } from "@tanstack/react-query";
import { fetchAccountTechnologies } from "../accountIntelligenceApi";
import { prospectKeys } from "../keys";

export function useAccountTechnologies(
  accountId: string | null,
  relationship: OrgTechnologyRelationship,
) {
  const query = useQuery<AccountTechnologiesResponse>({
    queryKey: prospectKeys.accountTechnologies(accountId ?? "", relationship),
    // No account selected is not a load — the drawer is closed.
    enabled: accountId !== null,
    queryFn: () => fetchAccountTechnologies(accountId as string, relationship),
  });

  return {
    rows: query.data?.technologies ?? [],
    /** false = this account has no Layer-0 bridge yet. Distinct from "bridged, found nothing" — the UI must
     *  say "not matched yet" rather than "builds nothing", which would be a claim we cannot support. */
    resolved: query.data?.resolved ?? false,
    /** What the bridged institution actually IS — so the drawer stops calling a university a company. */
    orgKind: query.data?.org_kind ?? null,
    loading: query.isPending && accountId !== null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load company technology"
      : null,
  };
}
