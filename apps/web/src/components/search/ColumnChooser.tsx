// ColumnChooser.tsx — the results-grid column toggle, shared by both Search panes.
//
// It started inside the People pane's ProspectToolbar, which is typed to ContactQuery because it also owns
// the sort control. The Accounts pane needs the SAME chooser over an AccountQuery grid, so the chooser (which
// cares about neither query type — only keys and labels) moved here, where both panes can reach it without a
// cross-feature import. Sorting stays with each pane's own toolbar: sort values ARE query-shaped.
"use client";

import { DropdownMenu, TpButton, TpCheckbox, TpIconButton } from "@leadwolf/ui";
import { Columns3 } from "lucide-react";

export interface ToggleableColumn {
  key: string;
  label: string;
}

export function ColumnChooser({
  columns,
  visibleColumns,
  onVisibleColumnsChange,
  label = "Choose columns",
  withLabel = false,
}: {
  /** Every toggleable column, in render order. Always-on columns are not listed. */
  columns: ToggleableColumn[];
  /** The keys currently shown. */
  visibleColumns: string[];
  /** Commit the next visible-column key set. */
  onVisibleColumnsChange: (keys: string[]) => void;
  label?: string;
  /** Search v4: render a labelled "Columns" ghost button instead of the bare icon. */
  withLabel?: boolean;
}) {
  const toggle = (key: string) =>
    onVisibleColumnsChange(
      visibleColumns.includes(key)
        ? visibleColumns.filter((k) => k !== key)
        : // Re-insert in the registry's order rather than appending, so turning a column off and back on
          // returns it to its own place instead of moving it to the end of the grid.
          columns
            .filter((c) => c.key === key || visibleColumns.includes(c.key))
            .map((c) => c.key),
    );

  return (
    <DropdownMenu
      align="end"
      trigger={({ toggle: open, props }) =>
        withLabel ? (
          <TpButton
            {...props}
            variant="ghost"
            size="sm"
            leftIcon={<Columns3 size={14} aria-hidden />}
            onClick={open}
          >
            Columns
          </TpButton>
        ) : (
          <TpIconButton {...props} label={label} onClick={open}>
            <Columns3 size={16} />
          </TpIconButton>
        )
      }
      items={columns.map((col) => ({
        // Render a checkbox row; keep the menu open by toggling via the checkbox change, not onSelect.
        label: (
          <TpCheckbox
            checked={visibleColumns.includes(col.key)}
            onChange={() => toggle(col.key)}
            label={col.label}
          />
        ),
      }))}
    />
  );
}
