// ListDetailPage - one list's members, with the work-the-list actions on them.
//
// Members render MASKED, exactly as the grid does: a domain, never an address. Opening a list is not a
// reveal, and the page has no path that turns it into one.
//
// One story: the surface takes a listId and loads both the list and its member page itself. The id has to be
// one the fixture collection actually contains - `fetchList` filters GET /lists client-side, so an unknown id
// is indistinguishable from a deleted one and renders the honest not-found state.
import { ListDetailPage } from "@leadwolf/ui";
import { LISTS } from "../prospect/fixtures";
import { Page } from "./_webPage";

/** "VPs of Eng (live)" - the dynamic list, kept in sync with its saved search. */
export const Loaded = () => (
  <Page height={900}>
    <ListDetailPage listId={LISTS[2].id} />
  </Page>
);
