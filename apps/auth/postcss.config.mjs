// postcss.config.mjs — the auth origin's CSS pipeline. Tailwind v4 ships its own PostCSS plugin (it
// bundles import-resolution + vendor-prefixing via Lightning CSS), so this is the only plugin needed.
export default { plugins: { "@tailwindcss/postcss": {} } };
