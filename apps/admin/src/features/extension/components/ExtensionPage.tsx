// ExtensionPage.tsx — the Chrome-extension distribution surface: the packaged build's version,
// its pinned extension id (the value EXTENSION_ORIGINS must carry), and the zip download.
// The zip + metadata are produced by the packaging step into public/downloads/ — this page
// only presents them; nothing here talks to /api/v1.
//
// The page sits in the DS PageContainer under a DS PageHeader like every other staff destination (it used to
// hand-roll its title as an <h2 style={{fontSize:15}}>, which is neither the page's heading level nor the
// page's title size), and renders its async states through the State Kit rather than an early-return ladder.
"use client";

import {
  Card,
  EmptyState,
  PageContainer,
  PageHeader,
  StateSwitch,
  StatusBadge,
  TpButton,
} from "@leadwolf/ui";
import { extensionZipHref } from "../api";
import { useExtensionMeta } from "../hooks/useExtensionMeta";
import type { ExtensionMeta } from "../types";

const FACT_LABEL: React.CSSProperties = {
  color: "var(--tp-ink-3)",
  fontSize: "var(--tp-text-caption)",
};
const FACT_VALUE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--tp-text-body)",
};

export function ExtensionPage() {
  const { meta, loading, error, reload } = useExtensionMeta();

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Chrome extension"
        subtitle="TruePoint — Prospect Capture. The zip below is the current production build; every install of it resolves to the pinned extension ID, which the API's extension allow-list (EXTENSION_ORIGINS) is configured to trust."
      />
      <StateSwitch
        loading={loading}
        error={error}
        empty={!loading && !error && meta === null}
        onRetry={reload}
        emptyState={
          <EmptyState
            title="No packaged build"
            description="Nothing has been published to public/downloads yet — run the extension packaging step."
          />
        }
      >
        {meta ? <BuildDetails meta={meta} /> : null}
      </StateSwitch>
    </PageContainer>
  );
}

function BuildDetails({ meta }: { meta: ExtensionMeta }) {
  const facts: Array<[string, string]> = [
    ["Extension version", meta.version],
    ["Minimum Chrome version", meta.minimumChromeVersion],
    ["Extension ID", meta.extensionId],
    ["Packaged", meta.builtAt],
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--tp-space-4)" }}>
      <Card>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: "var(--tp-space-1)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "var(--tp-space-2)" }}>
            <span style={{ fontWeight: 600 }}>truepoint-extension {meta.version}</span>
            <StatusBadge tone="success">current</StatusBadge>
          </div>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "max-content 1fr",
              gap: "6px var(--tp-space-4)",
              margin: 0,
            }}
          >
            {facts.map(([label, value]) => (
              <div key={label} style={{ display: "contents" }}>
                <dt style={FACT_LABEL}>{label}</dt>
                <dd style={{ ...FACT_VALUE, margin: 0 }}>{value}</dd>
              </div>
            ))}
          </dl>
          <div>
            <TpButton onClick={() => window.location.assign(extensionZipHref(meta))}>
              Download extension zip
            </TpButton>
          </div>
        </div>
      </Card>

      <section>
        <h2
          style={{
            fontSize: "var(--tp-text-title)",
            fontWeight: 600,
            marginBottom: "var(--tp-space-1)",
          }}
        >
          Install (unpacked)
        </h2>
        <ol
          style={{
            color: "var(--tp-ink-3)",
            fontSize: "var(--tp-text-body)",
            paddingLeft: 18,
            margin: 0,
          }}
        >
          <li>Unzip the download into a folder.</li>
          <li>
            Open <span style={FACT_VALUE}>chrome://extensions</span>, turn on Developer mode.
          </li>
          <li>Click "Load unpacked" and select the unzipped folder.</li>
          <li>The installed ID must match the Extension ID shown above.</li>
        </ol>
      </section>
    </div>
  );
}
