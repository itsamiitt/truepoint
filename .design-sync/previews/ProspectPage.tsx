// ProspectPage — the whole prospect surface: faceted rail (scope switch + saved/recent searches), the
// search + AI boxes, the results toolbar, the masked results grid with keyset "Load more", and the sticky
// bulk bar. It takes no props: search state lives in the URL and data comes from the slice's own hooks,
// which resolve against the fixture router in .design-sync/prospect/stubs/authClient.ts.
//
// ToastProvider comes from the app's (shell) layout in production; SaveSearchPanel and the bulk actions
// call useToast(), so a standalone card has to supply it. The RevealStore is ProspectPage's own.
//
// One cell — this is a full page, pinned to cardMode "single" at 1440x900 in config.json. Splitting it
// into variants would just render the same surface at a smaller size.
import { ProspectPage } from "@leadwolf/ui";
import { Shell } from "./_prospectShell";

/** The Contacts scope on first load: 24 masked rows, live facet counts, nothing selected. */
export const Surface = () => (
  <Shell>
    <ProspectPage />
  </Shell>
);
