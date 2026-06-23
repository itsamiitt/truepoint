import { DataTable } from "@leadwolf/ui";

type Lead = {
  id: string;
  name: string;
  company: string;
  stage: string;
  value: number;
};

const rows: Lead[] = [
  { id: "1", name: "Ava Thompson", company: "Northwind Traders", stage: "Qualified", value: 4200 },
  { id: "2", name: "Liam Chen", company: "Acme Co.", stage: "New", value: 1800 },
  { id: "3", name: "Noah Patel", company: "Globex", stage: "Won", value: 9600 },
  { id: "4", name: "Mia Rodriguez", company: "Initech", stage: "Qualified", value: 3100 },
];

const money = (n: number) => `$${n.toLocaleString()}`;

const columns = [
  { key: "name", header: "Name", cell: (r: Lead) => r.name, sortValue: (r: Lead) => r.name },
  { key: "company", header: "Company", cell: (r: Lead) => r.company },
  { key: "stage", header: "Stage", cell: (r: Lead) => r.stage },
  {
    key: "value",
    header: "Value",
    align: "right" as const,
    cell: (r: Lead) => money(r.value),
    sortValue: (r: Lead) => r.value,
  },
];

export function LeadsTable() {
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />;
}

export function SelectableRows() {
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      onRowClick={() => {}}
      isSelected={(r) => r.id === "3"}
    />
  );
}
