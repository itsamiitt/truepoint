// HomePage.tsx — the landing page.
//
// Three jobs, in order: say what this is, say what is real today, and get a developer into the reference.
// Anything that would need a form lives elsewhere — no page on this site collects an email address
// (ADR-0048 §D4), so the calls to action are links into the docs and into the product, not a waitlist input.

import { ButtonLink } from "@/components/ButtonLink.tsx";
import { PageIntro } from "@/components/PageIntro.tsx";
import intro from "@/components/page-intro.module.css";
import { endpointStatus } from "@/content/endpointStatus.ts";
import { PROOF_POINTS, SITE_TAGLINE } from "@/content/site.ts";
import { Card, PageContainer } from "@leadwolf/ui";
import styles from "../marketing.module.css";
import { EndpointIndex } from "./EndpointIndex.tsx";

export function HomePage() {
  return (
    <PageContainer width="default">
      <div className={styles.hero}>
        <PageIntro
          eyebrow="TruePoint Data"
          title="Company and people data, by API."
          lede={`${SITE_TAGLINE} Priced in credits you buy, metered on results, and documented in full before you talk to anyone.`}
        />
        <div className={styles.heroActions}>
          <ButtonLink href="/docs">Read the quickstart</ButtonLink>
          <ButtonLink href="/pricing" variant="secondary">
            See what a call costs
          </ButtonLink>
        </div>
      </div>

      <h2 className={intro.sectionTitle}>What we commit to</h2>
      <div className={styles.cardGrid}>
        {PROOF_POINTS.map((point) => (
          <Card key={point.title}>
            <h3 className={styles.cardTitle}>{point.title}</h3>
            <p className={styles.cardBody}>{point.body}</p>
          </Card>
        ))}
      </div>

      <h2 className={intro.sectionTitle}>The endpoints</h2>
      <p className={intro.sectionNote}>
        The contract is published in full below. {endpointStatus().line}
      </p>
      <EndpointIndex />

      <h2 className={intro.sectionTitle}>Where the data comes from</h2>
      <p className={intro.sectionNote}>
        Public web pages, official registries, licensed sources, and corrections contributed by
        TruePoint users about records they already work with. Every field carries the class of
        source it came from and when it was last seen. We do not collect from behind a login on any
        platform, and we do not run background collection.
      </p>
      <div className={styles.heroActions}>
        <ButtonLink href="/trust" variant="secondary">
          Read the sourcing statement
        </ButtonLink>
      </div>
    </PageContainer>
  );
}
