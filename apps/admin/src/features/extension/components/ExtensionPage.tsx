// ExtensionPage.tsx — the Chrome-extension distribution surface: the packaged build's version,
// its pinned extension id (the value EXTENSION_ORIGINS must carry), and the zip download.
// The zip + metadata are produced by the packaging step into public/downloads/ — this page
// only presents them; nothing here talks to /api/v1.
"use client";

import { Card, ErrorState, LoadingState, StatusBadge, TpButton } from "@leadwolf/ui";
import { extensionZipHref } from "../api";
import { useExtensionMeta } from "../hooks/useExtensionMeta";

const FACT_LABEL: React.CSSProperties = { color: "var(--tp-ink-3)", fontSize: 12 };
const FACT_VALUE: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 13 };

export function ExtensionPage() {
  const { meta, loading, error, reload } = useExtensionMeta();

  if (loading) return <LoadingState label="Loading extension build…" />;
  if (error || !meta)
    return <ErrorState detail={error ?? "Extension metadata unavailable"} onRetry={reload} />;

  const facts: Array<[string, string]> = [
    ["Extension version", meta.version],
    ["Minimum Chrome version", meta.minimumChromeVersion],
    ["Extension ID", meta.extensionId],
    ["Packaged", meta.builtAt],
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <div>
        <h2 style={{ fontSize: 15, fontWeight: 600 }}>Chrome extension</h2>
        <p style={{ color: "var(--tp-ink-3)", fontSize: 13 }}>
          TruePoint — Prospect Capture. The zip below is the current production build; every install
          of it resolves to the pinned extension ID, which the API's extension allow-list
          (EXTENSION_ORIGINS) is configured to trust.
        </p>
      </div>

      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600 }}>truepoint-extension {meta.version}</span>
            <StatusBadge tone="success">current</StatusBadge>
          </div>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "max-content 1fr",
              gap: "6px 16px",
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
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Install (unpacked)</h3>
        <ol style={{ color: "var(--tp-ink-3)", fontSize: 13, paddingLeft: 18, margin: 0 }}>
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
