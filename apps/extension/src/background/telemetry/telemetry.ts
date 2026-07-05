// Non-PII telemetry buffer (03 §2.3 taxonomy). Events are stored in IndexedDB and capped; batched
// upload is a follow-up. Never record name/email/phone/linkedin_url or any captured field.
import { db } from "../../shared/idb.ts";
import { getSettings } from "../../shared/storage.ts";
import type { ErrorClass } from "../../shared/types.ts";

const MAX_BUFFER = 500;

export class Telemetry {
  async event(name: string, props: Record<string, unknown> = {}): Promise<void> {
    await this.write("event", name, props);
  }

  async error(errorClass: ErrorClass, props: Record<string, unknown> = {}): Promise<void> {
    await this.write("error", `error.${errorClass}`, props);
  }

  private async write(
    kind: "event" | "error",
    event: string,
    props: Record<string, unknown>,
  ): Promise<void> {
    try {
      if (!(await getSettings()).telemetryEnabled) {
        return;
      }
      const database = await db();
      await database.put("telemetry", {
        id: crypto.randomUUID(),
        kind,
        event,
        props,
        ts: Date.now(),
      });
    } catch {
      // Telemetry must never break a product flow.
    }
  }

  /** Cap the buffer so a long offline period can't grow it unbounded. Called on the flush alarm. */
  async flush(): Promise<void> {
    try {
      const database = await db();
      const all = await database.getAll("telemetry");
      if (all.length <= MAX_BUFFER) {
        return;
      }
      const excess = all.slice(0, all.length - MAX_BUFFER);
      const tx = database.transaction("telemetry", "readwrite");
      await Promise.all(excess.map((record) => tx.store.delete(record.id)));
      await tx.done;
    } catch {
      // ignore
    }
  }
}
