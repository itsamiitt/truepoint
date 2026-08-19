// ContactsTable - the masked contact grid the import preview and list surfaces render.
//
// Rows are MASKED by construction: a domain, status flags and counts, never an address. Nothing here
// reveals a value - that is the reveal surface's job, and it charges for it.
import { ContactsTable } from "@leadwolf/ui";
import { CONTACTS } from "../prospect/fixtures";
import { Frame } from "./_webPage";

/** Twelve masked rows. */
export const Rows = () => (
  <Frame>
    <ContactsTable contacts={CONTACTS.slice(0, 12)} />
  </Frame>
);

/** A single row - the shape a one-contact preview shows. */
export const OneRow = () => (
  <Frame>
    <ContactsTable contacts={CONTACTS.slice(0, 1)} />
  </Frame>
);

/** Nothing matched. */
export const Empty = () => (
  <Frame>
    <ContactsTable contacts={[]} />
  </Frame>
);
