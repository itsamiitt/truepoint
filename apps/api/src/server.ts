// server.ts — Bun entry point. `bun run --hot src/server.ts` serves the composed Hono app.
import { app } from "./app.ts";

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
};
