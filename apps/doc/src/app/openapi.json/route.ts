// openapi.json/route.ts — the generated OpenAPI 3.1 document, served at the site root.
//
// `force-static` for the same reason as llms.txt: prerendered at build time, so this app keeps building with
// zero environment and never opts into a server runtime (ADR-0048 §D2).

import { renderOpenApiJson } from "@/content/openapi.ts";

export const dynamic = "force-static";

export function GET() {
  return new Response(renderOpenApiJson(), {
    headers: {
      // The registered media type for an OpenAPI document is application/openapi+json, but tools in the wild
      // sniff for application/json far more reliably — a Swagger UI or a generator pointed at this URL should
      // just work. The `openapi` member in the body is the authoritative declaration either way.
      "content-type": "application/json; charset=utf-8",
    },
  });
}
