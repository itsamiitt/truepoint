// @leadwolf/forge-api — the Forge capture-ingest edge + operator BFF (peer to apps/api; docs/planning/forge/07,
// re-homed from the truepoint-forge @forge/api). Authenticates operators with the EXISTING @leadwolf/auth
// (authn → requireCapability data:*) and the extension via the ADR-0045 companion-window token — NOT a bespoke
// Forge principal. Promotion writes master_* in-process via @leadwolf/db withErTx/forgeSyncRepository. The full
// routes land in P3; this is the boot stub.
import { Hono } from "hono";

const app = new Hono();
app.get("/ready", (c) => c.json({ ready: true }));
app.get("/live", (c) => c.json({ live: true }));

const port = Number(process.env.FORGE_API_PORT ?? 3005);
export default { port, fetch: app.fetch };
