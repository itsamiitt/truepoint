// llms.txt/route.ts — the machine reference, served as plain text at the site root.
//
// `force-static` is the load-bearing line. This app's defining property is that it prerenders completely and
// builds with zero environment (ADR-0048 §D2), and a route handler is the one thing in the App Router that
// would ordinarily opt a build into a server runtime. Pinned static, Next renders this once at build time
// into a file the CDN serves — the same posture as robots.ts and sitemap.ts, which are route handlers by
// another name.
//
// At the root rather than under /docs because that is where a crawler or an agent looks for it, next to
// robots.txt — the emerging llms.txt convention. The content itself is generated: see machineReference.ts.

import { buildMachineReference } from "@/content/machineReference.ts";

export const dynamic = "force-static";

export function GET() {
  return new Response(buildMachineReference(), {
    headers: {
      // charset is explicit: without it a UTF-8 em dash in the prose renders as mojibake in any client that
      // falls back to latin-1, and this document is full of them.
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
