// JobScheduler — drains the capture queue to POST /ingest with retry/backoff (02 §4/§11). Runs on the
// `drain` alarm (never setInterval — MV3 kills idle workers). Validation errors drop the item; auth /
// rate-limit / transient errors keep it and back off, so no capture is ever lost to a blip.
import { db } from "../../shared/idb.ts";
import type { QueueItem } from "../../shared/idb.ts";
import { ApiError } from "../api/client.ts";
import type { RuntimeContext } from "../context.ts";

const RECENT_TTL_MS = 24 * 60 * 60 * 1000;

export class JobScheduler {
  constructor(private readonly ctx: RuntimeContext) {}

  async drain(): Promise<void> {
    if (!this.ctx.config.isEnabled("captureEnabled")) {
      return;
    }
    const items = await this.ctx.queue.due();
    for (const item of items) {
      await this.ctx.queue.markInflight(item.idempotencyKey);
      try {
        const status = await this.ctx.api.ingest(item);
        await this.ctx.queue.remove(item.idempotencyKey);
        await this.addRecent(item, status.outcome);
        await this.ctx.telemetry.event("capture_result", { outcome: status.outcome });
        this.ctx.broadcast({ type: "SUBJECT_STATUS", subjectKey: item.record.subjectKey, status });
      } catch (error) {
        await this.handleError(item, error);
      }
    }
    this.ctx.broadcast({ type: "STATE_CHANGED", state: await this.ctx.getState() });
  }

  /** Never DELETE a capture on failure — park it.
   *
   *  A validation error used to remove the item outright, on the assumption that a 400 means a permanently
   *  malformed payload. It does not: `/ingest` answers 400 `No connector is registered for source
   *  'chrome_extension'` whenever CHROME_EXTENSION_ENABLED is unset — which is the production default. So every
   *  capture was classified as a client-side validation failure and destroyed, while the user had already been
   *  told it was saved. Configuration state and bad payloads are indistinguishable to this client by status
   *  alone, so it must not gamble a user's data on the guess.
   *
   *  Backoff is the safe answer for both: a genuinely malformed payload exhausts MAX_ATTEMPTS and parks as
   *  `failed` (retained and inspectable, never silently gone), while a not-yet-enabled connector recovers on
   *  its own once the flag flips. Captures are machine-generated, so a 400 almost always means a contract or
   *  configuration problem — exactly the case worth retrying. */
  private async handleError(item: QueueItem, error: unknown): Promise<void> {
    const errorClass = error instanceof ApiError ? error.errorClass : "transient";
    await this.ctx.queue.backoff(item);
    await this.ctx.telemetry.error(errorClass, {
      ...(error instanceof ApiError ? { status: error.status } : {}),
    });
  }

  private async addRecent(item: QueueItem, outcome: string): Promise<void> {
    const { fields, subjectKey } = item.record;
    const name =
      fields.fullName ??
      [fields.firstName, fields.lastName].filter(Boolean).join(" ") ??
      subjectKey;
    const database = await db();
    await database.put("recent", {
      contactId: subjectKey,
      name: name || subjectKey,
      company: fields.company ?? null,
      outcome,
      capturedAt: Date.now(),
      expiresAt: Date.now() + RECENT_TTL_MS,
    });
  }
}
