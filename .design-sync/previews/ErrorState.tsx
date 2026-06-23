import { ErrorState } from "@leadwolf/ui";

// A card surface so the error state reads like a failed panel in the app.
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

export function LoadFailed() {
  return (
    <Panel>
      <ErrorState
        title="Couldn't load leads"
        detail="We hit a network error reaching the server. Check your connection and try again."
        onRetry={() => {}}
      />
    </Panel>
  );
}

export function WithCustomRetry() {
  return (
    <Panel>
      <ErrorState
        title="Sync failed"
        detail="The last import from Salesforce didn't finish. 3 of 240 records were not written."
        onRetry={() => {}}
        retryLabel="Retry sync"
      />
    </Panel>
  );
}

export function MessageOnly() {
  return (
    <Panel>
      <ErrorState detail="This report is unavailable on your current plan." />
    </Panel>
  );
}
