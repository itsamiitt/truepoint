// types.ts — Sales Navigator slice view types (05 §5, M7). The wire shapes live in @leadwolf/types; this only
// adds the human-facing label map for the closed link_type enum so the UI never hardcodes the strings inline.

import type { SalesNavLinkType } from "@leadwolf/types";

/** Human labels for the closed link_type enum (mirrors @leadwolf/types salesNavLinkType). */
export const LINK_TYPE_LABELS: Record<SalesNavLinkType, string> = {
  profile: "Lead profile",
  account: "Account",
  saved_search: "Saved search",
  lead_list: "Lead list",
  account_list: "Account list",
  inmail_thread: "InMail thread",
};

/** The link_type options in display order, for the capture form's select. */
export const LINK_TYPE_OPTIONS: ReadonlyArray<{ value: SalesNavLinkType; label: string }> = (
  Object.keys(LINK_TYPE_LABELS) as SalesNavLinkType[]
).map((value) => ({ value, label: LINK_TYPE_LABELS[value] }));
