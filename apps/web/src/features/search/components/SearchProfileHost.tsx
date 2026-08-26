// SearchProfileHost.tsx — mounts whichever profile drawer the URL currently names (search-consolidation
// stage 3). One param is set at a time; this maps it to a drawer.
//
// Everything here is next/dynamic and ssr:false, and that is the point: a profile is only reachable on a row
// CLICK, so none of this belongs in the Search route's first load. `next/dynamic` on a statically-imported
// module splits nothing (the PA-3 lesson), which is why the drawers live in their own modules rather than
// being re-exported through a feature barrel this file also imports.
"use client";

import type { ProfileKind } from "@/components/search";
import dynamic from "next/dynamic";

const DatabasePersonProfileDrawer = dynamic(
  () =>
    import("@/features/accounts/components/DatabaseProfileDrawer").then(
      (m) => m.DatabasePersonProfileDrawer,
    ),
  { ssr: false },
);

const DatabaseCompanyProfileDrawer = dynamic(
  () =>
    import("@/features/accounts/components/DatabaseProfileDrawer").then(
      (m) => m.DatabaseCompanyProfileDrawer,
    ),
  { ssr: false },
);

export function SearchProfileHost({
  kind,
  profileKey,
  onClose,
  onMaterialized,
}: {
  kind: ProfileKind;
  profileKey: string;
  onClose: () => void;
  /** A database person became a workspace contact through a reveal in the drawer (reveal-as-save). */
  onMaterialized: (slug: string) => void;
}) {
  if (kind === "person") {
    return (
      <DatabasePersonProfileDrawer
        slug={profileKey}
        onClose={onClose}
        onMaterialized={onMaterialized}
      />
    );
  }
  if (kind === "company") {
    return <DatabaseCompanyProfileDrawer domain={profileKey} onClose={onClose} />;
  }
  // `contact` and `account` address OWNED records, whose drawers are the panes' own concern (RecordDetail
  // and the routed company page). They are not global profiles and are not hosted here.
  return null;
}
