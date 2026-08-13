// api.ts — the reports slice's data access. The MVP dashboards are composed client-side from the existing
// credits + contacts endpoints (the ClickHouse /reports/* pipeline is post-MVP — ADR-0010), fetched in
// parallel via fetchWithAuth and the in-memory access token (ADR-0016). The slice's only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { problemMessage } from "@/lib/problemMessage";
import { API_BASE } from "@/lib/publicConfig";
import { type ReportsSummary, reportsSummarySchema } from "@leadwolf/types";
import type { MaskedContact } from "@leadwolf/types";
import type { UsageReveal } from "./types";

/** The raw inputs every report dashboard derives from (see rollups.ts). */
export interface ReportsSource {
  balance: number;
  reveals: UsageReveal[];
  contacts: MaskedContact[];
}

/** GET /credits/balance — the headline tile. */
async function fetchBalance(): Promise<number> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/credits/balance`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load credit balance"));
  const data = (await res.json()) as { balance: number };
  return data.balance;
}

/** GET /credits/usage — the metered reveals feeding the credit + team rollups. */
async function fetchUsage(limit = 200): Promise<UsageReveal[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/credits/usage?limit=${limit}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load usage history"));
  const data = (await res.json()) as { reveals: UsageReveal[] };
  return data.reveals;
}

/** GET /contacts — masked rows feeding the funnel + data-health + team rollups (no PII needed). */
async function fetchContacts(limit = 200): Promise<MaskedContact[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts?limit=${limit}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load contacts"));
  const data = (await res.json()) as { contacts: MaskedContact[] };
  return data.contacts;
}

/** The balance tile's inputs. The dashboards' COUNTS now come from `fetchReportsSummary` instead, so these
 *  rows no longer decide any number on the page — which is what retires the sample disclosure that shipped
 *  while the rollups were still computed from them. */
export async function fetchReportsSource(): Promise<ReportsSource> {
  const [balance, reveals, contacts] = await Promise.all([
    fetchBalance(),
    fetchUsage(200),
    fetchContacts(200),
  ]);
  return { balance, reveals, contacts };
}

/** The deliverability report from GET /api/v1/email/analytics (M12 P5). Reply rate is the headline (D6). */
export interface DeliverabilityReport {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  replied: number;
  deliveryRate: number;
  openRate: number;
  clickRate: number;
  replyRate: number;
  bounceRate: number;
  complaintRate: number;
  rangeDays: number;
}

/** GET /api/v1/email/analytics — null when the endpoint isn't wired yet (404/501) so the panel can fall back. */
export async function fetchEmailDeliverability(days = 30): Promise<DeliverabilityReport | null> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/email/analytics?days=${days}`);
  if (res.ok) return (await res.json()) as DeliverabilityReport;
  if (res.status === 404 || res.status === 501) return null;
  throw new Error(await problemMessage(res, "Could not load deliverability analytics"));
}

/** Trigger a client-side CSV download. PII-free rollup rows only — never raw contact data. */
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number)[][],
): void {
  const escapeCell = (cell: string | number): string => {
    const s = String(cell);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [headers, ...rows].map((r) => r.map(escapeCell).join(",")).join("\n");
  const blob = new Blob([body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * GET /reports/summary — the SERVER-aggregated counts (C-3.10).
 *
 * The viewer's IANA zone travels with the request because the day buckets have always followed the local day;
 * Postgres reproduces that with `date_trunc('day', ts, $tz)`, so nothing shifts for non-UTC users. Falls back
 * to UTC on the rare runtime that cannot resolve a zone.
 */
export async function fetchReportsSummary(
  range: string,
  member: string,
  tz: string = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
): Promise<ReportsSummary> {
  const params = new URLSearchParams({ range, member, tz });
  const res = await fetchWithAuth(`${API_BASE}/api/v1/reports/summary?${params.toString()}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load reports"));
  return reportsSummarySchema.parse(await res.json());
}
