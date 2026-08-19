// WidgetCard - the container every Home widget sits in. It owns the four async states so no widget
// re-implements them: a skeleton while loading, an error with retry, a typed empty state, and the content.
//
// That is why the Home grid stays consistent: the states are the CARD's job. Note `icon` and `emptyIcon` are
// IconComponents - the lucide component itself, NOT a rendered `<Icon />` element - and `emptyTitle` is
// required even on a card that never shows its empty branch.
import { WidgetCard } from "@leadwolf/ui";
import { Users } from "lucide-react";
import { Frame } from "./_webPage";

const rows = (
  <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: "var(--tp-space-2)" }}>
    <li>Priya Raghunathan — VP of Revenue Operations</li>
    <li>Daniel Okonkwo — Chief Technology Officer</li>
    <li>Aisling Byrne — Senior Product Manager</li>
  </ul>
);

const base = {
  title: "Hot leads",
  icon: Users,
  emptyTitle: "No leads scored yet",
  emptyDescription: "Scores appear once contacts have been enriched.",
  emptyIcon: Users,
};

/** Content, with a title, a glyph and a right-aligned hint. */
export const Content = () => (
  <Frame>
    <WidgetCard {...base} hint="Top priority score" loading={false} error={null} empty={false}>
      {rows}
    </WidgetCard>
  </Frame>
);

/** Loading: the card's own skeleton, sized to the rows it expects. */
export const Loading = () => (
  <Frame>
    <WidgetCard {...base} loading skeletonRows={3} error={null} empty={false}>
      {rows}
    </WidgetCard>
  </Frame>
);

/** Empty: a typed empty state with its own glyph and copy, rather than a blank card. */
export const Empty = () => (
  <Frame>
    <WidgetCard {...base} loading={false} error={null} empty>
      {rows}
    </WidgetCard>
  </Frame>
);

/** Error, with the retry the card owns. */
export const Failed = () => (
  <Frame>
    <WidgetCard {...base} loading={false} error="The request timed out after 30s" empty={false} onRetry={() => {}}>
      {rows}
    </WidgetCard>
  </Frame>
);
