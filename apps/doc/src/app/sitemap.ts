// sitemap.ts — every URL on the site, generated from the content layer.
//
// Generated rather than hand-listed for the same reason the sidebar is: a guide or an endpoint added to the
// content modules should become a crawlable, linkable page without anyone remembering a second place to
// register it. A hand-maintained sitemap is a list that is wrong within a month.

import { DATASETS } from "@/content/datasets.ts";
import { ENDPOINTS } from "@/content/endpoints/index.ts";
import { GUIDES } from "@/content/guides/index.ts";
import { SITE_ORIGIN } from "@/content/site.ts";
import type { MetadataRoute } from "next";

const STATIC_PATHS = ["/", "/pricing", "/datasets", "/docs", "/trust", "/changelog"];

export default function sitemap(): MetadataRoute.Sitemap {
  const paths = [
    ...STATIC_PATHS,
    ...GUIDES.map((guide) => `/docs/${guide.slug}`),
    ...ENDPOINTS.map((endpoint) => `/docs/api/${endpoint.slug}`),
    ...DATASETS.map((dataset) => `/datasets/${dataset.slug}`),
  ];
  return paths.map((path) => ({ url: `${SITE_ORIGIN}${path}` }));
}
