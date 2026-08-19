// ExtensionPage — the published browser-extension build: version, extension id, minimum Chrome version and
// build time, with the download link for the packaged zip.
//
// This slice is the one console surface that does NOT go through the token client. Its metadata is a
// same-origin STATIC file (`public/downloads/extension-meta.json`) fetched with a plain `fetch` and no
// Bearer — deliberately, because it is public build metadata rather than an /api/v1/admin resource. That
// means the fixture router never sees it, and the card rendered "Extension metadata unavailable (404)".
//
// The shim below answers ONLY that one path and delegates everything else untouched.
import { ExtensionPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

const META = {
  version: "1.4.2",
  extensionId: "icdgalkohdcgcjjcbmfpdnhjcmhbnmpo",
  minimumChromeVersion: "116",
  filename: "truepoint-extension-1.4.2.zip",
  builtAt: "2026-08-15T12:04:00Z",
};

if (typeof window !== "undefined" && !("__tpExtensionMetaShim" in window)) {
  (window as unknown as Record<string, unknown>).__tpExtensionMetaShim = true;
  const real = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/downloads/extension-meta.json")) {
      return Promise.resolve(
        new Response(JSON.stringify(META), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return real(input as RequestInfo, init);
  }) as typeof window.fetch;
}

/** The published build, as staff see it before handing the id to the Chrome Web Store listing. */
export const Loaded = () => (
  <Page height={620}>
    <ExtensionPage />
  </Page>
);
