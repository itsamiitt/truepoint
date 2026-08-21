// not-found.tsx — the 404. Renders inside the root layout, so it keeps the masthead and the footer's route
// to privacy@truepoint.in; someone who mistyped a URL while trying to get their record removed should not
// land somewhere with no way onward.

import { ButtonLink } from "@/components/ButtonLink.tsx";
import { PageIntro } from "@/components/PageIntro.tsx";
import { PageContainer } from "@leadwolf/ui";

export default function NotFound() {
  return (
    <PageContainer width="default">
      <PageIntro
        eyebrow="404"
        title="That page isn't here."
        lede="The link may be out of date, or the page may have moved. The documentation index and the price list are both one click away."
      />
      <div style={{ display: "flex", gap: "var(--tp-space-3)", marginTop: "var(--tp-space-6)" }}>
        <ButtonLink href="/docs">Go to the docs</ButtonLink>
        <ButtonLink href="/" variant="secondary">
          Back to the start
        </ButtonLink>
      </div>
    </PageContainer>
  );
}
