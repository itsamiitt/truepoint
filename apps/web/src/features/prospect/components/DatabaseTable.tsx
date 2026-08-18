// DatabaseTable.tsx — the GLOBAL database results grid (Layer-0-as-database slice 2). A row is a person the
// PLATFORM holds, not a workspace record: there is no id, no owner and no reveal state — only profile facts,
// presence flags, and one action, "Add to workspace" (which materializes the licensed record). A person the
// workspace already holds shows an "In workspace" badge instead. Presentation only.
"use client";

import type { MaskedDatabasePerson } from "@leadwolf/types";
import { type Column, DataTable, StatusBadge, TpButton } from "@leadwolf/ui";
import styles from "../prospect.module.css";

export function DatabaseTable({
  people,
  adding,
  onAdd,
}: {
  people: MaskedDatabasePerson[];
  /** Slug currently being added (button busy state). */
  adding: string | null;
  onAdd: (person: MaskedDatabasePerson) => void;
}) {
  const columns: Column<MaskedDatabasePerson>[] = [
    {
      key: "name",
      header: "Name",
      sortValue: (p) => p.fullName ?? p.linkedinPublicId,
      cell: (p) => (
        <span className={styles.nameCell}>
          <span className={styles.nameMeta}>
            <span className={styles.name}>{p.fullName ?? p.linkedinPublicId}</span>
            <span className={styles.title}>
              {p.jobTitle ?? p.headline ?? "—"}
              {" · "}
              <a
                href={p.linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                profile
              </a>
            </span>
          </span>
        </span>
      ),
    },
    {
      key: "company",
      header: "Company",
      sortValue: (p) => p.companyName ?? "",
      cell: (p) => p.companyName ?? <span className="app-muted">—</span>,
    },
    {
      key: "location",
      header: "Location",
      sortValue: (p) => p.locationRaw ?? "",
      cell: (p) =>
        p.locationRaw ??
        [p.locationCity, p.locationCountry].filter(Boolean).join(", ") ?? (
          <span className="app-muted">—</span>
        ),
    },
    {
      key: "channels",
      header: "Contact data",
      align: "center",
      width: 120,
      sortValue: (p) => (p.hasEmail ? 2 : 0) + (p.hasPhone ? 1 : 0),
      cell: (p) => (
        <span style={{ display: "inline-flex", gap: 6 }}>
          <StatusBadge tone={p.hasEmail ? "success" : "muted"}>email</StatusBadge>
          <StatusBadge tone={p.hasPhone ? "success" : "muted"}>phone</StatusBadge>
        </span>
      ),
    },
    {
      key: "action",
      header: "",
      align: "right",
      width: 170,
      cell: (p) =>
        p.inWorkspace ? (
          <StatusBadge tone="success">In workspace</StatusBadge>
        ) : (
          <TpButton
            size="sm"
            disabled={adding === p.linkedinPublicId}
            onClick={(e) => {
              e.stopPropagation();
              onAdd(p);
            }}
          >
            {adding === p.linkedinPublicId ? "Adding…" : "Add to workspace"}
          </TpButton>
        ),
    },
  ];

  return <DataTable columns={columns} rows={people} rowKey={(p) => p.linkedinPublicId} />;
}
