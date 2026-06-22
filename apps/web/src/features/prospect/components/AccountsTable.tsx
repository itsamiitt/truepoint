// AccountsTable.tsx — the company-level results grid (the Accounts sibling of the Contacts DataTable in
// ProspectPage): Name + domain, Industry, Headcount, Revenue, Funding/Stage, and the #Contacts rollup (the
// workspace-scoped contactCount with its revealed sub-count). A row click hands off to onOpen (the page opens
// the AccountDetailDrawer). Token-styled via @leadwolf/ui; presentation only — the page owns data + selection.
"use client";

import type { MaskedAccount } from "@leadwolf/types";
import { type Column, DataTable, EmptyState, StatusBadge, TpChip } from "@leadwolf/ui";
import { Avatar } from "@leadwolf/ui";
import { Building2 } from "lucide-react";
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

function humanizeToken(v: string): string {
  return v
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bSeries ([a-z])\b/i, (_m, l: string) => `Series ${l.toUpperCase()}`);
}

export function AccountsTable({
  accounts,
  loading,
  onOpen,
  density,
}: {
  accounts: MaskedAccount[];
  loading: boolean;
  onOpen: (a: MaskedAccount) => void;
  /** Reserved for symmetry with the Contacts grid; DataTable reads [data-density] from an ancestor. */
  density?: string;
}) {
  const columns: Column<MaskedAccount>[] = [
    {
      key: "name",
      header: "Company",
      sortValue: (a) => a.name,
      cell: (a) => (
        <span className={styles.nameCell}>
          <Avatar name={a.name} size={28} />
          <span className={styles.nameMeta}>
            <span className={styles.name}>{a.name}</span>
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

  // density is accepted for parity with the Contacts grid; the shared DataTable reads [data-density] from the
  // page wrapper, so it is referenced here only to keep the prop in the public interface.
  void density;

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
