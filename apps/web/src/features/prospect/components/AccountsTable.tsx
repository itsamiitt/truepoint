// AccountsTable.tsx — the company-level results grid (the Accounts sibling of the Contacts DataTable in
// ProspectPage): Name + domain, Industry, Headcount, Revenue, Funding/Stage, and the #Contacts rollup (the
// workspace-scoped contactCount with its revealed sub-count). A row click hands off to onOpen (the page opens
// the routed /companies/:id page). Token-styled via @leadwolf/ui; presentation only — the page owns data + selection.
"use client";

import type { MaskedAccount } from "@leadwolf/types";
import { type Column, DataTable, EmptyState, StatusBadge, TpChip } from "@leadwolf/ui";
import { Avatar } from "@leadwolf/ui";
import { Building2 } from "lucide-react";
import { ACCOUNT_DEFAULT_VISIBLE_COLUMNS as DEFAULT_VISIBLE } from "../columnRegistry";
import styles from "../prospect.module.css";

/** Human label for an employee count → a coarse size band ("1–10", "51–200", "10k+"). */
export function headcountLabel(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

/** Compact "Funding · Stage" descriptor, em-dash when neither is known. */
function fundingStageLabel(a: MaskedAccount): string {
  const parts = [a.fundingStage, a.companyStage]
    .filter((v): v is string => Boolean(v))
    .map(humanizeToken);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function textCell(value: string | null | undefined) {
  return value ? <span>{value}</span> : <span className={styles.glyphNone}>—</span>;
}

function humanizeToken(v: string): string {
  return v
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bSeries ([a-z])\b/i, (_m, l: string) => `Series ${l.toUpperCase()}`);
}

// Re-exported so the pane imports its columns from one place; the definitions live in the alias-free
// registry module so they can be unit-tested.
export {
  ACCOUNT_TOGGLEABLE_COLUMNS,
  ACCOUNT_DEFAULT_VISIBLE_COLUMNS,
} from "../columnRegistry";

export function AccountsTable({
  accounts,
  loading,
  onOpen,
  isDatabaseRow,
  visibleColumns,
}: {
  accounts: MaskedAccount[];
  loading: boolean;
  onOpen: (a: MaskedAccount) => void;
  /**
   * Marks a row as coming from the platform DATABASE rather than the workspace (search-consolidation stage
   * 2). Optional, so the workspace-only callers are unchanged. Without it a database row is visually
   * identical to an owned one, and the grid would silently claim the workspace holds companies it does not.
   */
  isDatabaseRow?: (a: MaskedAccount) => boolean;
  /**
   * The toggleable column keys to show. Omitted ⇒ the default set, so the callers that don't offer a chooser
   * are unchanged. (Density is NOT a prop: the shared DataTable reads [data-density] from an ancestor, so
   * the PANE sets it on its wrapper — this grid taking a `density` it could only ignore was what made the
   * Accounts tab silently drop the setting.)
   */
  visibleColumns?: string[];
}) {
  const shown = new Set(visibleColumns ?? DEFAULT_VISIBLE);
  const allColumns: Column<MaskedAccount>[] = [
    {
      key: "name",
      header: "Company",
      sortValue: (a) => a.name,
      cell: (a) => (
        <span className={styles.nameCell}>
          <Avatar name={a.name} size={28} />
          <span className={styles.nameMeta}>
            <span className={styles.name}>
              {a.name}
              {isDatabaseRow?.(a) ? (
                // Not colour alone: the chip carries the word, so the distinction survives for anyone who
                // cannot tell the two tones apart (WCAG 2.2 AA).
                <>
                  {" "}
                  <TpChip>Not saved</TpChip>
                </>
              ) : null}
            </span>
            <span className={styles.mono}>{a.domain ?? "—"}</span>
          </span>
        </span>
      ),
    },
    {
      key: "industry",
      header: "Industry",
      sortValue: (a) => a.industry ?? "",
      cell: (a) => <span>{a.industry ?? "—"}</span>,
    },
    {
      key: "headcount",
      header: "Headcount",
      align: "right",
      width: 110,
      sortValue: (a) => a.employeeCount ?? -1,
      cell: (a) => <span className={styles.mono}>{headcountLabel(a.employeeCount)}</span>,
    },
    {
      key: "revenue",
      header: "Revenue",
      width: 130,
      sortValue: (a) => a.revenueRange ?? "",
      cell: (a) => <span>{a.revenueRange ?? "—"}</span>,
    },
    {
      key: "funding",
      header: "Funding / Stage",
      width: 180,
      cell: (a) =>
        a.fundingStage || a.companyStage ? (
          <TpChip>{fundingStageLabel(a)}</TpChip>
        ) : (
          <span className={styles.glyphNone}>—</span>
        ),
    },
    {
      key: "subIndustry",
      header: "Sub-industry",
      width: 160,
      sortValue: (a) => a.subIndustry ?? "",
      cell: (a) => textCell(a.subIndustry),
    },
    {
      key: "location",
      header: "HQ location",
      width: 170,
      sortValue: (a) => [a.hqCity, a.hqCountry].filter(Boolean).join(", "),
      cell: (a) => textCell([a.hqCity, a.hqCountry].filter(Boolean).join(", ") || null),
    },
    {
      key: "technologies",
      header: "Technologies",
      width: 200,
      sortValue: (a) => a.technologies.length,
      cell: (a) =>
        a.technologies.length === 0 ? (
          <span className={styles.glyphNone}>—</span>
        ) : (
          // The first few plus a count, not the whole stack: a wide technology list would set the column's
          // width for every row in the grid.
          <span>
            {a.technologies.slice(0, 2).join(", ")}
            {a.technologies.length > 2 ? ` +${a.technologies.length - 2}` : ""}
          </span>
        ),
    },
    {
      key: "founded",
      header: "Founded",
      align: "right",
      width: 100,
      sortValue: (a) => a.foundedYear ?? -1,
      cell: (a) => (
        <span className={styles.mono}>{a.foundedYear != null ? a.foundedYear : "—"}</span>
      ),
    },
    {
      key: "icp",
      header: "ICP fit",
      align: "right",
      width: 100,
      sortValue: (a) => a.icpFitScore ?? -1,
      cell: (a) => (
        <span className={styles.mono}>{a.icpFitScore != null ? a.icpFitScore : "—"}</span>
      ),
    },
    {
      key: "contacts",
      header: "Contacts",
      align: "right",
      width: 130,
      sortValue: (a) => a.contactCount,
      cell: (a) => (
        <StatusBadge tone={a.revealedContactCount > 0 ? "success" : "muted"}>
          {a.contactCount.toLocaleString()}
          {a.revealedContactCount > 0
            ? ` · ${a.revealedContactCount.toLocaleString()} revealed`
            : ""}
        </StatusBadge>
      ),
    },
  ];

  // `name` is the row's identity and always shows; everything else answers to the chooser.
  const columns = allColumns.filter((c) => c.key === "name" || shown.has(c.key));

  return (
    <DataTable
      columns={columns}
      rows={accounts}
      rowKey={(a) => a.id}
      onRowClick={(a) => onOpen(a)}
      empty={
        loading ? null : (
          <EmptyState
            icon={<Building2 size={28} />}
            title="No companies"
            description="No accounts match this search. Adjust your firmographic filters or import more from the Import surface."
          />
        )
      }
    />
  );
}
