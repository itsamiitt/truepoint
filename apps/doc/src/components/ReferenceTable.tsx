"use client";

// ReferenceTable.tsx — a reference table, rendered through the design system's DataTable.
//
// Reference tables here are prose in a grid (three columns of explanation), not a data grid — but they are
// still a table, and truepoint-design bans hand-rolled ones where a DS equivalent exists. DataTable is that
// equivalent, and using it is what gets the sticky header, the measured wrapping rows and the horizontal
// scroll container for free. That last one matters most: a wide table on a phone has to scroll inside its own
// box, never take the page sideways with it.
//
// The "use client" is load-bearing, not decoration. DataTable's API is column DESCRIPTORS carrying `cell` and
// `rowKey` FUNCTIONS, and DataTable is itself a client component — so building those functions in a server
// component and handing them across the boundary fails the build outright ("Functions cannot be passed
// directly to Client Components"). Marking the boundary here instead means the server pages pass only
// `headers` and `rows`, which are plain serializable data, and the descriptors are built client-side.

import { DataTable } from "@leadwolf/ui";

interface Row {
  readonly id: string;
  readonly cells: readonly string[];
}

export function ReferenceTable({
  headers,
  rows,
}: {
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}) {
  const columns = headers.map((header, index) => ({
    key: header,
    header,
    cell: (row: Row) => row.cells[index] ?? "",
  }));
  const tableRows: Row[] = rows.map((cells, index) => ({ id: String(index), cells }));
  return <DataTable columns={columns} rows={tableRows} rowKey={(row) => row.id} />;
}
