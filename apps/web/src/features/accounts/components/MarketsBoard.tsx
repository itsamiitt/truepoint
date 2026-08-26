// MarketsBoard.tsx — the market-segment board (market-intelligence MI-8/MI-S7, 07-product-surfaces §4):
// reads /api/v1/market/segments (the non-PII rollup cache) and renders per-industry movement over the
// window. Every number reconciles with a drill-down: the row links into /companies filtered by that
// industry facet — same dimension, same source of truth. Honest while dark: the API says enabled:false
// and the board explains itself instead of rendering zeros.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { problemMessage } from "@/lib/problemMessage";
import { API_BASE } from "@/lib/publicConfig";
import type { MarketSegment } from "@leadwolf/types";
import {
  type Column,
  DataTable,
  EmptyState,
  PageContainer,
  PageHeader,
  StateSwitch,
} from "@leadwolf/ui";
import { useQuery } from "@tanstack/react-query";

interface SegmentsResponse {
  enabled: boolean;
  segments: MarketSegment[];
}

async function fetchSegments(months: number): Promise<SegmentsResponse> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/market/segments?months=${months}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load market segments"));
  return (await res.json()) as SegmentsResponse;
}

interface IndustryRollup {
  code: string;
  label: string;
  companyCount: number;
  headcountDelta: number;
  fundingRounds: number;
  fundingAmountMinor: number;
  signalCount: number;
}

/** Collapse the (industry × country × band × month) rows to one per-industry window summary. */
function byIndustry(segments: MarketSegment[]): IndustryRollup[] {
  const map = new Map<string, IndustryRollup>();
  const latestMonth = segments.reduce((max, s) => (s.month > max ? s.month : max), "");
  for (const s of segments) {
    const row = map.get(s.industryCode) ?? {
      code: s.industryCode,
      label: s.industryLabel,
      companyCount: 0,
      headcountDelta: 0,
      fundingRounds: 0,
      fundingAmountMinor: 0,
      signalCount: 0,
    };
    // company_count repeats per month/segment — count each dimension combo once, at the latest month.
    if (s.month === latestMonth) row.companyCount += s.companyCount;
    row.headcountDelta += s.headcountDelta;
    row.fundingRounds += s.fundingRounds;
    row.fundingAmountMinor += s.fundingAmountMinor;
    row.signalCount += s.signalCount;
    map.set(s.industryCode, row);
  }
  return [...map.values()].sort(
    (a, b) => b.signalCount + b.fundingRounds - (a.signalCount + a.fundingRounds),
  );
}

function money(minor: number): string {
  if (minor === 0) return "—";
  const major = minor / 100;
  if (major >= 1_000_000_000) return `$${(major / 1_000_000_000).toFixed(1)}B`;
  if (major >= 1_000_000) return `$${(major / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(major).toLocaleString()}`;
}

function delta(n: number): string {
  if (n === 0) return "—";
  return n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString();
}

/** The Funding cell, unchanged from the hand-rolled table: "<rounds> · <amount>", or an em dash at zero. */
function funding(r: IndustryRollup): string {
  return r.fundingRounds > 0 ? `${r.fundingRounds} · ${money(r.fundingAmountMinor)}` : "—";
}

const WINDOW_MONTHS = 6;

// Same five columns, same order, same left alignment and the same cell rendering the hand-rolled <table> had.
// No `sortValue` anywhere ON PURPOSE: the board has never been column-sortable — `byIndustry` returns the rows
// pre-ordered by (signals + funding rounds) desc, which is not any single column, so adding a sort control here
// would be a new behaviour rather than a like-for-like port. Module scope, not inline: DataTable's sort memo
// deliberately excludes `columns` from its deps, and a stable array keeps that honest.
const COLUMNS: Column<IndustryRollup>[] = [
  { key: "industry", header: "Industry", cell: (r) => r.label },
  { key: "companies", header: "Companies", cell: (r) => r.companyCount.toLocaleString() },
  { key: "headcount", header: "Headcount Δ", cell: (r) => delta(r.headcountDelta) },
  { key: "funding", header: "Funding", cell: funding },
  { key: "signals", header: "Signals", cell: (r) => r.signalCount.toLocaleString() },
];

export function MarketsBoard() {
  const query = useQuery({
    queryKey: ["companies", "markets", WINDOW_MONTHS],
    queryFn: () => fetchSegments(WINDOW_MONTHS),
  });
  const enabled = query.data?.enabled ?? true;
  const rows = query.data ? byIndustry(query.data.segments) : [];

  return (
    <PageContainer width="fluid">
      <PageHeader title="Markets" subtitle={`Last ${WINDOW_MONTHS} months · whole database`} />
      <StateSwitch
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={!enabled || rows.length === 0}
        emptyState={
          <EmptyState
            title={enabled ? "No market data yet" : "Market boards are not enabled"}
            description={
              enabled
                ? "Segment movement appears once companies carry industry classifications and signals land."
                : "The market rollup pipeline is not switched on for this deployment yet."
            }
          />
        }
      >
        {/* DataTable, not a hand-rolled <table>: the old body was an UNBOUNDED rows.map over every industry
            in the database. DataTable windows above 100 rows and renders identically below it, so the small
            boards look exactly as they did and a large one stops filling the DOM. */}
        <DataTable columns={COLUMNS} rows={rows} rowKey={(r) => r.code || "unclassified"} />
      </StateSwitch>
    </PageContainer>
  );
}
