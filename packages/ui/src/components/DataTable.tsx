"use client";
// DataTable.tsx — the shared results/usage/log grid: typed columns, client sort, density (reads [data-density]
// from an ancestor), optional row click + selection, sticky header. Not virtualized yet (hand-rolled; a TanStack
// swap is a follow-up once a package manager is available) — parents should page with the Pagination primitive.
import { type ReactNode, useMemo, useState } from "react";
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

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
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
  }, [rows, sort, columns]);

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
