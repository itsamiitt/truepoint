// useCreditBalance.ts — the bulk bar's view of the tenant's reveal-credit balance.
//
// The implementation moved to `@/lib/credits`, because the top-bar CreditPill reads the same endpoint and the
// two were drifting: each kept its own copy of the number and re-fetched independently on the same window
// event. Re-exported from here so the feature's callers keep importing it from the feature.
"use client";

export { useCreditBalance } from "@/lib/credits";
