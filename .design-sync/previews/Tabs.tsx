import { Tabs } from "@leadwolf/ui";
import { useState } from "react";

const PANEL: Record<string, { title: string; body: string }> = {
  overview: { title: "Overview", body: "412 contacts · 38 added this week · 12 owners across 3 teams." },
  activity: { title: "Activity", body: "Liam Chen logged a call · Ava Thompson sent a sequence step." },
  files: { title: "Files", body: "9 attachments · last upload “Q2-pricing.pdf” 2 days ago." },
  settings: { title: "Settings", body: "Auto-enrich on · Round-robin assignment · Dedupe by email." },
};

const items = [
  { value: "overview", label: "Overview" },
  { value: "activity", label: "Activity" },
  { value: "files", label: "Files" },
  { value: "settings", label: "Settings" },
];

function Panel({ value }: { value: string }) {
  const p = PANEL[value];
  return (
    <div style={{ padding: "16px 4px 4px" }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--tp-ink)", marginBottom: 4 }}>
        {p.title}
      </div>
      <p style={{ margin: 0, fontSize: 13, color: "var(--tp-ink-3)", lineHeight: 1.5 }}>{p.body}</p>
    </div>
  );
}

export function RecordTabs() {
  const [value, setValue] = useState("overview");
  return (
    <div style={{ minWidth: 360 }}>
      <Tabs items={items} value={value} onChange={setValue} aria-label="List sections" />
      <Panel value={value} />
    </div>
  );
}

export function ActivitySelected() {
  const [value, setValue] = useState("activity");
  return (
    <div style={{ minWidth: 360 }}>
      <Tabs items={items} value={value} onChange={setValue} aria-label="List sections" />
      <Panel value={value} />
    </div>
  );
}

export function TwoTabs() {
  const [value, setValue] = useState("inbox");
  return (
    <div style={{ minWidth: 280 }}>
      <Tabs
        items={[
          { value: "inbox", label: "Inbox" },
          { value: "archived", label: "Archived" },
        ]}
        value={value}
        onChange={setValue}
        aria-label="Mailbox"
      />
      <p style={{ margin: "16px 0 0", fontSize: 13, color: "var(--tp-ink-3)" }}>
        {value === "inbox" ? "23 unread threads" : "1,204 archived threads"}
      </p>
    </div>
  );
}
