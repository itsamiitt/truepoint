// robots.ts — this site is meant to be indexed, which is the opposite of every other app in the fleet.
//
// The plan's position is that the documentation is the sales team, so search and agent-tool crawlers are the
// distribution channel rather than a threat. There is nothing here to protect: no session, no personal data,
// no authenticated surface. The only rule worth stating is where the sitemap lives.

import { SITE_ORIGIN } from "@/content/site.ts";
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
  };
}
