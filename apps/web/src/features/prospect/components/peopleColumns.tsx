// peopleColumns.tsx — how each People results-grid column RENDERS. Which columns exist, and which are on by
// default, is columnRegistry.ts.
//
// Lifted out of PeoplePane (which was 600 lines and owned both the surface and every cell renderer) so the
// column set can grow without the pane growing with it. The pane keeps the state, the wiring and the
// engines; this file knows what a column looks like and nothing else.
//
// NOT HERE, deliberately: an Owner column. `ownerUserId` is a UUID, and the only member→name source lives in
// features/settings-workspace, which this slice may not import (lint:cross-feature is a ratchet at its
// current budget). A column of raw ids is worse than no column; it needs a shared members source first.
"use client";

import { DataHealthCell } from "@/components/data-health";
import type { Column } from "@leadwolf/ui";
import { StatusBadge, Tooltip, TpChip } from "@leadwolf/ui";
import type { ProspectRow } from "../databaseRows";
import type { BulkSelectionStore } from "../hooks/useBulkSelection";
import styles from "../prospect.module.css";
import {
  OUTREACH_STATUS_LABELS,
  SENIORITY_LABELS,
  companyLabel,
  displayName,
  emailGlyphForRow,
  phoneLineTypeLabel,
  profileHref,
  shortDate,
} from "../types";
import type { RowBulkAction } from "./BulkActionBar";
import { RevealCell } from "./RevealCell";
import { RowActions } from "./RowActions";
import { RowSelectCheckbox, SelectAllCheckbox } from "./SelectionControls";

// Re-exported so the pane imports its columns from one place; the definitions live in the alias-free
// registry module so they can be unit-tested.
export {
  PEOPLE_TOGGLEABLE_COLUMNS as TOGGLEABLE_COLUMNS,
  PEOPLE_DEFAULT_VISIBLE_COLUMNS as DEFAULT_VISIBLE_COLUMNS,
} from "../columnRegistry";

export interface PeopleColumnDeps {
  selectionStore: BulkSelectionStore;
  /** The ids selectable right now (owned rows only — a database row has no contact id to act on). */
  shownIds: string[];
  onRevealed: (id: string) => void;
  /** A not-saved row's reveal landed: the person is a workspace contact now — flip the row in place. */
  onMaterialized: (slug: string, row: ProspectRow) => void;
  onRowAction: (id: string, action: RowBulkAction) => void;
}

function textCell(value: string | null | undefined) {
  return value ? <span>{value}</span> : <span className={styles.glyphNone}>—</span>;
}

export function buildPeopleColumns({
  selectionStore,
  shownIds,
  onRevealed,
  onMaterialized,
  onRowAction,
}: PeopleColumnDeps): Column<ProspectRow>[] {
  return [
    {
      key: "select",
      header: (
        <SelectAllCheckbox
          store={selectionStore}
          shownIds={shownIds}
          className={styles.headCheck}
        />
      ),
      width: 36,
      cell: (c) => (
        <RowSelectCheckbox
          store={selectionStore}
          id={c.id}
          label={`Select ${displayName(c)}`}
          disabledReason={c.databaseSlug ? "Reveal to save this person first" : undefined}
          className={styles.rowCheck}
        />
      ),
    },
    {
      key: "name",
      header: "Name",
      sortValue: (c) => displayName(c),
      cell: (c) => {
        const href = profileHref(c);
        return (
          <span className={styles.nameCell}>
            <span className={styles.nameMeta}>
              <span className={styles.name}>
                {displayName(c)}
                {c.databaseSlug ? (
                  // Not colour alone: the chip carries the word (WCAG 2.2 AA), and it is the one place the
                  // grid says which side a row is on — its reveal is what saves it (decisions.md 2026-08-25).
                  // Matches the Accounts grid's chip. [A-01]
                  <>
                    {" "}
                    <TpChip>Not saved</TpChip>
                  </>
                ) : null}
              </span>
              <span className={styles.title}>
                {c.jobTitle ?? "—"}
                {href ? (
                  <>
                    {" · "}
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      aria-label="Open profile"
                    >
                      profile
                    </a>
                  </>
                ) : null}
              </span>
            </span>
          </span>
        );
      },
    },
    {
      key: "company",
      header: "Company",
      // Account name first (works for email-less contacts — capture/import rows), email domain as the
      // fallback facet the column used to show exclusively. Shared with the drawers via companyLabel so the
      // same row cannot read two different ways depending on where you look at it.
      sortValue: (c) => companyLabel(c) ?? "",
      cell: (c) =>
        c.companyName ? (
          <span>{c.companyName}</span>
        ) : (
          <span className={styles.mono}>{c.emailDomain ?? "—"}</span>
        ),
    },
    {
      key: "seniority",
      header: "Seniority",
      width: 130,
      sortValue: (c) => (c.seniorityLevel ? SENIORITY_LABELS[c.seniorityLevel] : ""),
      cell: (c) => textCell(c.seniorityLevel ? SENIORITY_LABELS[c.seniorityLevel] : null),
    },
    {
      key: "department",
      header: "Department",
      width: 140,
      sortValue: (c) => c.department ?? "",
      cell: (c) => textCell(c.department),
    },
    {
      key: "location",
      header: "Location",
      width: 160,
      sortValue: (c) => [c.locationCity, c.locationCountry].filter(Boolean).join(", "),
      cell: (c) => textCell([c.locationCity, c.locationCountry].filter(Boolean).join(", ") || null),
    },
    {
      key: "email",
      header: "Email status",
      align: "center",
      width: 76,
      sortValue: (c) => c.emailStatus,
      cell: (c) => {
        const g = emailGlyphForRow(c);
        const cls =
          g.tone === "ok"
            ? styles.glyphOk
            : g.tone === "warn"
              ? styles.glyphWarn
              : styles.glyphNone;
        return (
          <Tooltip label={g.label}>
            <span className={`${styles.glyph} ${cls}`} aria-label={g.label}>
              {g.mark}
            </span>
          </Tooltip>
        );
      },
    },
    {
      key: "address",
      header: "Email",
      cell: (c) => (
        <RevealCell
          contact={c}
          field="email"
          onRevealed={onRevealed}
          onMaterialized={onMaterialized}
        />
      ),
    },
    {
      key: "phone",
      header: "Phone",
      sortValue: (c) => (c.hasPhone ? 1 : 0),
      cell: (c) => (
        <RevealCell
          contact={c}
          field="phone"
          onRevealed={onRevealed}
          onMaterialized={onMaterialized}
        />
      ),
    },
    {
      // The TCPA-relevant mobile-vs-landline signal, pre-reveal ([S-04]): it is a classification, never the
      // number, so it is safe to show on a masked row.
      key: "lineType",
      header: "Line type",
      width: 120,
      sortValue: (c) => phoneLineTypeLabel(c.phoneLineType ?? null) ?? "",
      cell: (c) => textCell(phoneLineTypeLabel(c.phoneLineType ?? null)),
    },
    {
      key: "outreach",
      header: "Outreach",
      width: 140,
      sortValue: (c) => OUTREACH_STATUS_LABELS[c.outreachStatus],
      cell: (c) => (
        <StatusBadge tone="muted">{OUTREACH_STATUS_LABELS[c.outreachStatus]}</StatusBadge>
      ),
    },
    {
      key: "health",
      header: "Data health",
      width: 170,
      sortValue: (c) => c.dataHealth?.score ?? -1,
      cell: (c) => <DataHealthCell health={c.dataHealth} />,
    },
    {
      key: "verified",
      header: "Last verified",
      width: 130,
      sortValue: (c) => c.lastVerifiedAt ?? "",
      cell: (c) => <span className={styles.mono}>{shortDate(c.lastVerifiedAt)}</span>,
    },
    {
      key: "created",
      header: "Added",
      width: 130,
      sortValue: (c) => c.createdAt,
      cell: (c) => <span className={styles.mono}>{shortDate(c.createdAt)}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: 48,
      cell: (c) => (
        <span
          className={styles.rowCheck}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          {c.databaseSlug ? (
            // A not-saved row has no list/tag/status — those are workspace facts; its save gesture is the
            // reveal (decisions.md 2026-08-25). The menu keeps the honest email hint and the LinkedIn link.
            <RowActions
              contact={c}
              onOpenLinkedin={
                c.databaseUrl
                  ? () => window.open(c.databaseUrl, "_blank", "noopener,noreferrer")
                  : undefined
              }
            />
          ) : (
            <RowActions
              contact={c}
              onAddToList={() => onRowAction(c.id, "list")}
              onTag={() => onRowAction(c.id, "addTags")}
              onChangeStatus={() => onRowAction(c.id, "status")}
              // RowActions renders this item only when the callback is supplied, and the grid never supplied
              // it — so "Open LinkedIn" was dead code on every row that had a profile url to open. Supplied
              // when (and only when) there is somewhere to go, which is the contract the menu expects.
              onOpenLinkedin={
                profileHref(c)
                  ? () => window.open(profileHref(c) as string, "_blank", "noopener,noreferrer")
                  : undefined
              }
            />
          )}
        </span>
      ),
    },
  ];
}
