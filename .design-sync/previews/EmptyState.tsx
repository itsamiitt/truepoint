import { EmptyState, Icon, TpButton } from "@leadwolf/ui";
import { Inbox, Search, Users } from "./_glyphs";

// A card surface so the empty state reads like an empty panel in the app.
function Panel({ children, width = 440 }: { children: import("react").ReactNode; width?: number }) {
  return (
    <div
      style={{
        width,
        border: "1px solid var(--tp-hairline)",
        borderRadius: "var(--radius)",
        background: "var(--tp-surface)",
      }}
    >
      {children}
    </div>
  );
}

export function NoContacts() {
  return (
    <Panel>
      <EmptyState
        icon={<Icon icon={Users} size={28} />}
        title="No contacts yet"
        description="Import a CSV or add your first contact to start building your pipeline."
        action={<TpButton variant="primary">Import contacts</TpButton>}
      />
    </Panel>
  );
}

export function NoResults() {
  return (
    <Panel>
      <EmptyState
        icon={<Icon icon={Search} size={28} />}
        title="No results for “acme corp”"
        description="Try a different spelling or clear your filters to see all leads."
        action={<TpButton variant="secondary">Clear filters</TpButton>}
      />
    </Panel>
  );
}

export function EmptyInbox() {
  return (
    <Panel>
      <EmptyState
        icon={<Icon icon={Inbox} size={28} />}
        title="You're all caught up"
        description="New replies from your sequences will land here."
      />
    </Panel>
  );
}
