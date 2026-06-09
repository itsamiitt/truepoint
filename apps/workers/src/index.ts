// index.ts — the workers process entry. Boots every queue consumer and handles graceful shutdown so
// in-flight jobs drain before exit. Run with `bun run dev` (against the docker-compose Redis).

import { startWorkers } from "./register.ts";

const workers = startWorkers();
console.log(`workers: started ${workers.length} queue processor(s)`);

async function shutdown(signal: string): Promise<void> {
  console.log(`workers: ${signal} received, draining…`);
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
