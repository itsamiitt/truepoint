"use client";
// DataTable.tsx — the shared results/usage/log grid: typed columns, client sort, density (reads [data-density]
// from an ancestor), optional row click + selection, sticky header.
//
// STILL NOT VIRTUALIZED (C-3.9). Every accumulated row is rendered, and the "Load more" surfaces grow that
// set 50-100 rows at a time, so this violates the truepoint-design hard rule about un-virtualized large
// lists. The remaining fix is a windowed row renderer (/react-virtual is absent from the lockfile),
// which is a new dependency plus changed rendering across every table that uses this — parents should keep
// paging with the Pagination primitive until then.
//
// What IS fixed: the client sort no longer re-runs on every parent render (see the memo below).
import { type ReactNode, useMemo, useRef, useState } from "react";
import { cn } from "../cn.ts";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Provide to enable client-side sort on this column. */
  sortValue?: (row: T) => string | number;
  width?: number | string;
  align?: "left" | "right" | "center";
}

interface SortState {
  key: string;
  dir: "asc" | "desc";
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  isSelected,
  empty,
  className,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  isSelected?: (row: T) => boolean;
  /** Body shown when there are no rows (e.g. an <EmptyState/>). */
  empty?: ReactNode;
  className?: string;
}) {
  const [sort, setSort] = useState<SortState | null>(null);

  // Latest-value ref so the memo can read the current columns without taking them as a dependency.
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columnsRef.current.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const accessor = col.sortValue;
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = accessor(a);
      const bv = accessor(b);
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return cmp * factor;
    });
    // Deps are [rows, sort] — NOT columns. Callers build `columns` as a fresh array literal on every render
    // (verified: nearly every call site does `const columns: Column<T>[] = [...]` inline), so including it made
    // this memo miss on EVERY parent render and re-sort the entire accumulated row set — which the "Load more"
    // surfaces grow by 50-100 rows at a time. The sort only ever reads the ACTIVE column.s `sortValue`, so the
    // array identity was never the real input.
    //
    // The trade, stated plainly: changing a column.s `sortValue` IMPLEMENTATION without rows or sort changing
    // will not re-sort. `sortValue` is a pure accessor chosen at author time, so that does not happen at
    // runtime — and if it ever needs to, the caller can change the sort key or memoize `columns` itself.
  }, [rows, sort]);

  const toggleSort = (key: string) => {
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  };

  return (
    <div className={cn("tp-ui-table-wrap", className)}>
      <table className="tp-ui-table">
        <thead>
          <tr>
            {columns.map((col) => {
              const sortable = !!col.sortValue;
              const active = sort?.key === col.key;
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: header click-sort is a pointer convenience; a keyboard sort control is design-backlog work
                <th
                  key={col.key}
                  className={cn(sortable && "tp-ui-th-sortable")}
                  style={{ width: col.width, textAlign: col.align ?? "left" }}
                  onClick={sortable ? () => toggleSort(col.key) : undefined}
                  aria-sort={
                    active ? (sort?.dir === "asc" ? "ascending" : "descending") : undefined
                  }
                >
                  {col.header}
                  {sortable ? (
                    <span className="tp-ui-th-arrow" aria-hidden>
                      {active ? (sort?.dir === "asc" ? "↑" : "↓") : "↕"}
                    </span>
                  ) : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ padding: 0 }}>
                {empty ?? null}
              </td>
            </tr>
          ) : (
            sorted.map((row, i) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: row click is a pointer convenience; the row's focusable controls carry the keyboard path
              <tr
                key={rowKey(row, i)}
                className={cn(onRowClick && "tp-ui-tr-clickable")}
                aria-selected={isSelected ? isSelected(row) : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((col) => (
                  <td key={col.key} style={{ textAlign: col.align ?? "left" }}>
                    {col.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
