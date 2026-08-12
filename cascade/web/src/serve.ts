// Dev server: serves the Explorer AND proxies /v1 to the API in-process, so
// `bun run dev:web` gives you the whole stack (migrated + seeded) on one port.

import { join } from "node:path";
import { EXAMPLE_IDS, applyMigrations, createPgliteClient, seedExample } from "@cascade/db";
import { createApp } from "../../api/src/app";

const PORT = Number(process.env.PORT ?? 3200);

const db = await createPgliteClient();
await applyMigrations(db);
await seedExample(db);
const api = createApp({ db });

// import.meta.dir, not new URL().pathname — the latter yields "/C:/…" on Windows.
const html = (await Bun.file(join(import.meta.dir, "index.html")).text()).replace(
  "window.__SEED_ORG__",
  JSON.stringify(EXAMPLE_IDS.orgSage),
);

const bundle = await Bun.build({
  entrypoints: [join(import.meta.dir, "app.ts")],
  target: "browser",
});
if (!bundle.success) {
  console.error({ msg: "bundle_failed", logs: bundle.logs });
  process.exit(1);
}
const appJs = await bundle.outputs[0]!.text();

console.info({
  msg: "explorer_listening",
  url: `http://localhost:${PORT}`,
  seed_org: EXAMPLE_IDS.orgSage,
});

export default {
  port: PORT,
  fetch(req: Request) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/v1")) return api.fetch(req);
    if (url.pathname === "/app.js") {
      return new Response(appJs, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
