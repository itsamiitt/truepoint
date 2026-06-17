// DeveloperPage.tsx — the Developer settings console (12 §5). To avoid adding new routes/nav items (navConfig is
// off-limits), the four sub-surfaces — API keys · OAuth apps · Webhooks · API docs — live behind a Tabs switch
// inside the single /settings/api-keys page. Each panel owns its own data + empty/connect states.
"use client";

import { Tabs, type TabItem } from "@leadwolf/ui";
import { useState } from "react";
import { ApiDocsPanel } from "./ApiDocsPanel";
import { ApiKeysPanel } from "./ApiKeysPanel";
import { OAuthAppsPanel } from "./OAuthAppsPanel";
import { WebhooksPanel } from "./WebhooksPanel";
import styles from "../settings-developer.module.css";

type DeveloperTab = "keys" | "oauth" | "webhooks" | "docs";

const TABS: TabItem[] = [
  { value: "keys", label: "API keys" },
  { value: "oauth", label: "OAuth apps" },
  { value: "webhooks", label: "Webhooks" },
  { value: "docs", label: "API docs" },
];

export function DeveloperPage() {
  const [tab, setTab] = useState<DeveloperTab>("keys");

  return (
    <section>
      <h1 className="tp-settings-title">Developer</h1>
      <Tabs
        className={styles.tabs}
        items={TABS}
        value={tab}
        onChange={(v) => setTab(v as DeveloperTab)}
        aria-label="Developer settings sections"
      />
      {tab === "keys" ? <ApiKeysPanel /> : null}
      {tab === "oauth" ? <OAuthAppsPanel /> : null}
      {tab === "webhooks" ? <WebhooksPanel /> : null}
      {tab === "docs" ? <ApiDocsPanel /> : null}
    </section>
  );
}
