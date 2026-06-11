// (shell)/inbox/page.tsx — the Inbox destination's calm placeholder (11 §4.4). Replies + tasks land here
// once mailbox sync ships (the M9 reply-ingestion design gate); until then this static card explains the
// plan and points at Sequences for send status. No feature slice yet — nothing to fetch, no fake data.
// Styling is inline with --tp-* tokens only (a one-card page; no co-located module needed yet).
import { Card } from "@leadwolf/ui";
import Link from "next/link";

export default function InboxRoute() {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 24,
        padding: "28px 32px 48px",
        maxWidth: 880,
      }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h1
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            color: "var(--tp-ink)",
          }}
        >
          Inbox
        </h1>
        <p style={{ margin: 0, fontSize: 14, color: "var(--tp-ink-3)" }}>Unified replies + tasks</p>
      </header>

      <Card>
        <h2 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 600, color: "var(--tp-ink)" }}>
          Inbox — unified replies + tasks
        </h2>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--tp-ink-2)" }}>
          Replies will land here once mailbox sync ships — the M9 reply-ingestion design gate
          (direct Gmail / Microsoft Graph sync versus a unified inbox vendor) is decided before that
          build, so nothing is synced yet. Until then, you can follow send status per enrollment in{" "}
          <Link
            href="/sequences"
            style={{
              color: "var(--tp-ink)",
              textDecoration: "underline",
              textUnderlineOffset: 2,
            }}
          >
            Sequences
          </Link>
          .
        </p>
      </Card>
    </main>
  );
}
