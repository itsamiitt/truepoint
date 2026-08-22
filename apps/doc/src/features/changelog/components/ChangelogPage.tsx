// ChangelogPage.tsx — the dated record of contract changes.
//
// Sorted here rather than in the content file so an entry can be appended to CHANGELOG without anyone having
// to keep the array in order.

import { PageIntro } from "@/components/PageIntro.tsx";
import { CHANGELOG } from "@/content/changelog.ts";
import { FEED_PATH } from "@/content/feed.ts";
import { PageContainer } from "@leadwolf/ui";
import styles from "../changelog.module.css";

/** ISO dates sort correctly as strings, which is exactly why the content type requires ISO. */
const ENTRIES = [...CHANGELOG].sort((a, b) => b.date.localeCompare(a.date));

export function ChangelogPage() {
  return (
    <PageContainer width="default">
      <PageIntro
        eyebrow="Changelog"
        title="What changed, and when."
        lede="Entries are added when the published contract, the price, or the sourcing posture changes. A data vendor who moves those quietly is one you cannot build on."
      />

      <p className={styles.subscribe}>
        Nobody polls a documentation page, so this log is also an <a href={FEED_PATH}>Atom feed</a>{" "}
        — subscribe and a contract change reaches you without you remembering to look.
      </p>

      <ol className={styles.list}>
        {ENTRIES.map((entry) => (
          <li key={`${entry.date}-${entry.title}`} className={styles.entry}>
            <time className={styles.date} dateTime={entry.date}>
              {entry.date}
            </time>
            <div>
              <h2 className={styles.title}>{entry.title}</h2>
              <p className={styles.body}>{entry.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </PageContainer>
  );
}
