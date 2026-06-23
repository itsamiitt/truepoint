// ImportPage.tsx — composes the import slice: the wizard above, the workspace's masked contacts below. The
// wizard's onImported reloads the list so a successful import is visible immediately. This is the feature's
// public component (rendered by the thin app/import route).
"use client";

import { PageHeader } from "@/components/PageHeader";
import { EmptyState, StateSwitch } from "@leadwolf/ui";
import { useContacts } from "../hooks/useContacts";
import { ContactsTable } from "./ContactsTable";
import { ImportWizard } from "./ImportWizard";

export function ImportPage() {
  const { contacts, error, loading, reload } = useContacts();

  return (
    <main className="app-main">
      <PageHeader title="Contacts" />
      <ImportWizard onImported={() => void reload()} />

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
