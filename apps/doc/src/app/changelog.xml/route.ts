// changelog.xml/route.ts — the changelog as a subscribable Atom feed.
//
// `force-static` for the same reason as the other two generated artifacts: prerendered at build time, so the
// app keeps building with zero environment and never opts into a server runtime (ADR-0048 §D2).

import { buildFeed } from "@/content/feed.ts";

export const dynamic = "force-static";

export function GET() {
  return new Response(buildFeed(), {
    headers: { "content-type": "application/atom+xml; charset=utf-8" },
  });
}
