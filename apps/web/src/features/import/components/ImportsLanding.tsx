// ImportsLanding.tsx — the /imports section landing (import-redesign 11 §1.1, S-U1 scaffold). An honest
// stand-in, not the product: the import history dashboard (11 §2) replaces this component in place at S-U2.
// Until then the page states what it will hold and offers the one action that already works — starting an
// import. Static surface: nothing is fetched, so there is no loading/error state to wire (11 §8.4 marks
// static surfaces n/a).
"use client";

import { PageHeader } from "@/components/PageHeader";
import { EmptyState, TpButton } from "@leadwolf/ui";
import { Upload } from "lucide-react";
import { useRouter } from "next/navigation";

export function ImportsLanding() {
  const router = useRouter();
  return (
    <main className="app-main">
      <PageHeader
        title="Imports"
        actions={
          <TpButton variant="primary" type="button" onClick={() => router.push("/imports/new")}>
            New import
          </TpButton>
        }
      />
      <section className="tp-card">
        <EmptyState
          icon={<Upload size={28} aria-hidden />}
          title="Import history isn’t here yet"
          description="Once the imports dashboard ships, your past and running imports will appear here. You can start a new import now — it runs to completion either way."
        />
      </section>
    </main>
  );
}
