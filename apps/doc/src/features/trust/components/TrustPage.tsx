// TrustPage.tsx — the public data ethics and sourcing statement.
//
// Sections carry their own `id` so each is directly linkable: the footer points at #your-data, and an
// enterprise buyer's security review will want to point a colleague at one section rather than the page.

import { PageIntro } from "@/components/PageIntro.tsx";
import { Prose } from "@/components/Prose.tsx";
import intro from "@/components/page-intro.module.css";
import { TRUST_SECTIONS } from "@/content/trust.ts";
import { PageContainer } from "@leadwolf/ui";

export function TrustPage() {
  return (
    <PageContainer width="default">
      <PageIntro
        eyebrow="Trust"
        title="How we source data, and what we refuse to collect."
        lede="Every field we store is attributable to a class of source. This page says which sources those are, what falls outside our scope entirely, and how to get your own record removed."
      />

      {TRUST_SECTIONS.map((section) => (
        <section key={section.id} id={section.id}>
          <h2 className={intro.sectionTitle}>{section.title}</h2>
          <Prose blocks={section.blocks} />
        </section>
      ))}
    </PageContainer>
  );
}
