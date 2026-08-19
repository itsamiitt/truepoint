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
import { EmptyState, StateSwitch } from "@leadwolf/ui";
import { useQuery } from "@tanstack/react-query";
import styles from "../companies.module.css";

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

const WINDOW_MONTHS = 6;

export function MarketsBoard() {
  const query = useQuery({
    queryKey: ["companies", "markets", WINDOW_MONTHS],
    queryFn: () => fetchSegments(WINDOW_MONTHS),
  });
  const enabled = query.data?.enabled ?? true;
  const rows = query.data ? byIndustry(query.data.segments) : [];

  return (
    <section>
      <div className={styles.indexHead}>
        <h1 className="tp-settings-title" style={{ margin: 0 }}>
          Markets
        </h1>
        <span className={styles.deptSummary}>last {WINDOW_MONTHS} months · whole database</span>
      </div>
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
        <div className={styles.boardWrap}>
          <table className={styles.board}>
            <thead>
              <tr>
                <th>Industry</th>
                <th>Companies</th>
                <th>Headcount Δ</th>
                <th>Funding</th>
                <th>Signals</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code || "unclassified"}>
                  <td>{r.label}</td>
                  <td>{r.companyCount.toLocaleString()}</td>
                  <td>{delta(r.headcountDelta)}</td>
                  <td>
                    {r.fundingRounds > 0
                      ? `${r.fundingRounds} · ${money(r.fundingAmountMinor)}`
                      : "—"}
                  </td>
                  <td>{r.signalCount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateSwitch>
    </section>
  );
}
