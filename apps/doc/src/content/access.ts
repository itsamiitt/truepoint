// access.ts — what "callable" actually means for the company endpoints today.
//
// The site had drifted into implying open availability. The endpoints are built and metered (ADR-0049), the
// pages badge them beta, and the landing sentence now counts them as callable — but the router is mounted
// behind `PUBLIC_DATA_API_ENABLED`, and `deploy/env.production.template` ships it OFF, with the comment
// "leave OFF until the endpoints have been reviewed for this deployment: while off the router is not mounted
// and /api/v1/public/* 404s".
//
// So a developer who read these pages, minted a key in Settings → Developer (that surface IS live either
// way, deliberately — a credential can be provisioned before the endpoints it calls are switched on) and
// then curled the base URL would get a 404 from a route that was never mounted, with nothing on the site
// having warned them. That is not a wrong badge — beta is honest about the CONTRACT — it is a missing
// sentence about ACCESS.
//
// The two are genuinely different axes and the site now says both: availability describes whether the
// contract is settled; this describes whether the door is open for you yet.

/** The one sentence every surface that says "callable" pairs with. */
export const ACCESS_NOTE =
  "Access is enabled per account. The endpoints are built and metered, and keys can be created before they are switched on for you — so a 404 from the base URL means your account is not enabled yet, not that the path is wrong.";

/** The short form, for places where the full sentence would crowd the surrounding copy. */
export const ACCESS_NOTE_SHORT = "Enabled per account";

/** Where a reader goes to ask for it. Kept beside the note so the two cannot drift apart. */
export const ACCESS_CONTACT = "mailto:hello@truepoint.in";
