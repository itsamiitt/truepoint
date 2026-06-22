// ImportPage.tsx — composes the import slice: the wizard above, the workspace's masked contacts below. The
// wizard's onImported reloads the list so a successful import is visible immediately. This is the feature's
// public component (rendered by the thin app/import route).
"use client";

import { useContacts } from "../hooks/useContacts";
import { ContactsTable } from "./ContactsTable";
import { ImportWizard } from "./ImportWizard";

export function ImportPage() {
  const { contacts, error, loading, reload } = useContacts();

  return (
    <main className="app-main">
      <h1>Contacts</h1>
      <ImportWizard onImported={() => void reload()} />

      <section className="tp-card">
        <h2>Workspace contacts {loading ? "" : `(${contacts.length})`}</h2>
        {error ? <p className="tp-error">{error}</p> : <ContactsTable contacts={contacts} />}
      </section>
    </main>
  );
}
