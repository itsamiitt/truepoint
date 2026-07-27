"use client";
// DataTable.tsx — the shared results/usage/log grid: typed columns, client sort, density (reads [data-density]
// from an ancestor), optional row click + selection, sticky header.
//
// VIRTUALIZED above VIRTUALIZE_THRESHOLD rows (C-3.9), which is what the truepoint-design hard rule about
// un-virtualized large lists requires: the "Load more" surfaces grow the rendered set 50-100 rows at a time
// and every accumulated row used to stay in the DOM.
//
// A WINDOW virtualizer, not a scroll-container one, because `.tp-ui-table-wrap` has `overflow: auto` but no
// bounded height — these tables grow the page, and the page is what scrolls. Using a container virtualizer
// would have meant giving the wrapper a fixed height, which changes the layout of every surface that uses it.
// This way the visual result is identical; only the number of rows in the DOM changes.
//
// Below the threshold NOTHING changes: the rows render exactly as before. That keeps the blast radius on the
// many small tables (settings, logs, members) at zero, and the overhead of windowing is not worth paying for
// a list that fits on a screen or two anyway.
//
// The spacer rows carry the height of the un-rendered rows so the scrollbar and the page height stay honest.
// They are aria-hidden and hold a single empty cell: a `<tr>` with no `<td>` is invalid table markup, and a
// screen reader should not announce the padding as a row.
//
// Also fixed here earlier: the client sort no longer re-runs on every parent render (see the memo below).
import { type VirtualItem, useWindowVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { cn } from "../cn.ts";
import { windowPadding } from "./virtualWindow.ts";

/** Row count above which rows are windowed. Below it the table renders every row, exactly as it always did. */
const VIRTUALIZE_THRESHOLD = 100;
/** Starting row-height guess (matches --tp-row-h). Rows are MEASURED after mount, so density and wrapped
 *  cells correct themselves; this only decides the first paint's scrollbar. */
const ESTIMATED_ROW_H = 44;

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

  // The tbody's document offset: a window virtualizer measures from the top of the PAGE, so it needs to know
  // how far down the rows start (header, filters, page chrome) or it windows the wrong range.
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const virtualize = sorted.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useWindowVirtualizer({
    // Hooks cannot be conditional, so the virtualizer always exists and is simply empty when not in use.
    count: virtualize ? sorted.length : 0,
    estimateSize: () => ESTIMATED_ROW_H,
    overscan: 12,
    scrollMargin: bodyRef.current?.offsetTop ?? 0,
  });

  const virtualRows = virtualize ? virtualizer.getVirtualItems() : [];
  const { top: padTop, bottom: padBottom } = windowPadding(
    virtualRows,
    virtualize ? virtualizer.getTotalSize() : 0,
    virtualizer.options.scrollMargin,
  );

  const renderRow = (row: T, index: number, virtual?: VirtualItem) => (
    // biome-ignore lint/a11y/useKeyWithClickEvents: row click is a pointer convenience; the row's focusable controls carry the keyboard path
    <tr
      key={rowKey(row, index)}
      data-index={index}
      ref={virtual ? virtualizer.measureElement : undefined}
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
  );

  const spacer = (height: number, key: string) =>
    height > 0 ? (
      <tr key={key} aria-hidden style={{ height }}>
        <td colSpan={columns.length} style={{ padding: 0, border: 0 }} />
      </tr>
    ) : null;

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
        <tbody ref={bodyRef}>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ padding: 0 }}>
                {empty ?? null}
              </td>
            </tr>
          ) : virtualize ? (
            <>
              {spacer(padTop, "tp-vpad-top")}
              {virtualRows.map((virtual) =>
                renderRow(sorted[virtual.index] as T, virtual.index, virtual),
              )}
              {spacer(padBottom, "tp-vpad-bottom")}
            </>
          ) : (
            sorted.map((row, i) => renderRow(row, i))
          )}
        </tbody>
      </table>
    </div>
  );
}
