import { SegmentedControl } from "@leadwolf/ui";
import { useState } from "react";

export function ContactsAccounts() {
  const [value, setValue] = useState("contacts");
  return (
    <SegmentedControl
      items={[
        { value: "contacts", label: "Contacts" },
        { value: "accounts", label: "Accounts" },
      ]}
      value={value}
      onChange={setValue}
      aria-label="Record type"
    />
  );
}

export function Timeframe() {
  const [value, setValue] = useState("month");
  return (
    <SegmentedControl
      items={[
        { value: "day", label: "Day" },
        { value: "week", label: "Week" },
        { value: "month", label: "Month" },
        { value: "quarter", label: "Quarter" },
      ]}
      value={value}
      onChange={setValue}
      aria-label="Timeframe"
    />
  );
}

export function ViewMode() {
  const [value, setValue] = useState("board");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SegmentedControl
        items={[
          { value: "list", label: "List" },
          { value: "board", label: "Board" },
        ]}
        value={value}
        onChange={setValue}
        aria-label="View mode"
      />
      <span style={{ fontSize: 13, color: "var(--tp-ink-3)" }}>
        Pipeline shown as {value === "board" ? "kanban board" : "flat list"}.
      </span>
    </div>
  );
}
