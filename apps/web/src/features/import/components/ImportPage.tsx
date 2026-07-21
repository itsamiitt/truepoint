// ImportPage.tsx — composes the import slice: the wizard above, the workspace's masked contacts below. The
// wizard's onImported reloads the list so a successful import is visible immediately. This is the feature's
// public component (rendered by the thin app/(shell)/imports/new route; the retired /import route redirects
// here — import-redesign 11 §1.1, S-U1). S-U7: this page owns the wizard's URL half — the ?draft=/?step=
// deep-link is read off window.location on mount and mirrored back via history.replaceState (the BillingPage
// pattern — replace semantics so back/refresh land correctly, and no useSearchParams Suspense constraint).
"use client";

import { PageHeader } from "@/components/PageHeader";
import { EmptyState, StateSwitch } from "@leadwolf/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { type DraftStep, parseStepParam } from "../draftFlow";
import { useContacts } from "../hooks/useContacts";
import type { DraftUrlState } from "../hooks/useImportDraft";
import { ContactsTable } from "./ContactsTable";
import { ImportWizard } from "./ImportWizard";

/** Read the S-U7 deep-link params off the current URL. Mount-time only (client), hydration-safe. */
function readDraftParamsFromUrl(): { draftId: string | null; step: DraftStep | null } {
  const params = new URLSearchParams(window.location.search);
  return { draftId: params.get("draft"), step: parseStepParam(params.get("step")) };
}

/** Mirror the draft flow's step into the query string (null = left draft mode → clean URL). */
function writeDraftParamsToUrl(state: DraftUrlState | null): void {
  const url = new URL(window.location.href);
  if (state) {
    url.searchParams.set("draft", state.draftId);
    url.searchParams.set("step", state.step);
  } else {
    url.searchParams.delete("draft");
    url.searchParams.delete("step");
  }
  window.history.replaceState(null, "", url.toString());
}

export function ImportPage() {
  const router = useRouter();
  const { contacts, error, loading, reload } = useContacts();
  const [deepLink, setDeepLink] = useState<{ draftId: string | null; step: DraftStep | null } | null>(
    null,
  );
  useEffect(() => setDeepLink(readDraftParamsFromUrl()), []);

  return (
    <main className="app-main">
      <PageHeader title="Contacts" />
      {/* Hand off to the durable job page on submit (11 §4, S-U3): the import runs there, navigable away, no
          dead 2-min poll. The contacts list below refreshes on return. */}
      <ImportWizard
        onStarted={(jobId) => router.push(`/imports/${jobId}`)}
        resumeDraftId={deepLink?.draftId ?? null}
        initialStep={deepLink?.step ?? null}
        onDraftUrlChange={writeDraftParamsToUrl}
      />

      <section className="tp-card">
        <h2>Workspace contacts {loading ? "" : `(${contacts.length})`}</h2>
        <StateSwitch
          loading={loading}
          error={error}
          empty={contacts.length === 0}
          onRetry={() => void reload()}
          emptyState={
            <EmptyState
              title="No contacts yet"
              description="Import a CSV above to populate this workspace."
            />
          }
        >
          <ContactsTable contacts={contacts} />
        </StateSwitch>
      </section>
    </main>
  );
}
