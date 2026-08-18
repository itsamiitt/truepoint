// types.ts — the shape of public/downloads/extension-meta.json, written by the extension
// packaging step alongside the zip. Static same-origin data, not an API contract — so the
// type lives here, not in @leadwolf/types.
export type ExtensionMeta = {
  version: string;
  extensionId: string;
  minimumChromeVersion: string;
  filename: string;
  builtAt: string;
};
