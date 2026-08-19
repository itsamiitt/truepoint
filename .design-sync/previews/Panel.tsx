// Panel — the extension's side panel: brand bar with the credits pill, the three-tab row, and the tab body.
//
// The panel reads two sources and both are real here. Its account/credits state comes over the message bus
// (stubbed at .design-sync/apps/extension/stubs/client.ts, the one chrome.runtime touch point), and its
// Captured list comes from IndexedDB — which a preview page really does have. `Seed` writes the same
// `recent` rows the service worker writes after a capture, then mounts the panel, so the card shows a
// working panel instead of the first-run empty state. No panel code is bypassed.
import { db, Panel } from "@leadwolf/ui";
import { type ReactNode, useEffect, useState } from "react";

const RECENT = [
  { contactId: "ct_01hq8m4pv7", name: "Priya Raghavan", company: "Northwind Logistics", outcome: "saved", capturedAt: 1_755_507_262_000, expiresAt: 1_758_099_262_000 },
  { contactId: "ct_01hq8m5rt2", name: "Daniel Okafor", company: "Northwind Logistics", outcome: "saved", capturedAt: 1_755_507_065_000, expiresAt: 1_758_099_065_000 },
  { contactId: "ct_01hq8m6xk9", name: "Aisha Khan", company: "Halcyon MedTech", outcome: "duplicate", capturedAt: 1_755_506_321_000, expiresAt: 1_758_098_321_000 },
  { contactId: "ct_01hq8m7bn4", name: "Marta Svensson", company: null, outcome: "queued", capturedAt: 1_755_505_923_000, expiresAt: 1_758_097_923_000 },
];

/** Write the recent rows, then mount — so the panel's own read finds them instead of an empty store. */
function Seed({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const database = await db();
        await Promise.all(RECENT.map((r) => database.put("recent", r)));
      } catch {
        // An unavailable IndexedDB is not a reason to show nothing: the panel's own error branch is a real
        // state too, so fall through and let it render whatever it finds.
      }
      if (live) setReady(true);
    })();
    return () => {
      live = false;
    };
  }, []);
  return ready ? <>{children}</> : null;
}

const frame: React.CSSProperties = {
  width: 400,
  height: 700,
  overflow: "hidden",
  border: "1px solid var(--tp-hairline, #f0f0f0)",
  borderRadius: 10,
  background: "#fff",
};

/** The side panel as it looks after a few captures: signed in, credits on hand, four recent contacts. */
export const Captured = () => (
  <div style={frame}>
    <Seed>
      <Panel />
    </Seed>
  </div>
);
