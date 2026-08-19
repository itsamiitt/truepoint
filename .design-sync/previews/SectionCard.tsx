// SectionCard - the titled container every Data health section sits in: a title, an optional hint, and
// whatever the section renders.
//
// A layout primitive, so its card has to show it doing its job rather than an empty frame - each cell puts
// real content inside it.
import { SectionCard, StatTile } from "@leadwolf/ui";
import { Frame } from "./_webPage";

/** With a hint - the usual form, where the hint explains what the number means. */
export const WithHint = () => (
  <Frame>
    <SectionCard title="Email verification" hint="Share of contacts whose email was confirmed deliverable">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--tp-space-3)" }}>
        <StatTile label="Valid" value="39,460" sublabel="82% of contacts with an email" />
        <StatTile label="Risky" value="1,925" sublabel="4%" />
        <StatTile label="Invalid" value="1,444" sublabel="3%" />
      </div>
    </SectionCard>
  </Frame>
);

/** Without a hint, for a section whose title is self-explanatory. */
export const TitleOnly = () => (
  <Frame>
    <SectionCard title="Freshness">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--tp-space-3)" }}>
        <StatTile label="Fresh" value="32,722" sublabel="Verified in the last 90 days" />
        <StatTile label="Stale" value="11,549" sublabel="Older than 90 days" />
        <StatTile label="Never verified" value="3,849" sublabel="No verification on record" />
      </div>
    </SectionCard>
  </Frame>
);
