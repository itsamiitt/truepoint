// IndexedDB schema + open — the durable store that survives MV3 service-worker termination
// (02 §8). The capture queue MUST outlive the worker so a killed-mid-drain capture is never lost.
import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { CapturedRecord } from "./types.ts";

export interface QueueItem {
  idempotencyKey: string;
  record: CapturedRecord;
  attempts: number;
  nextAttemptAt: number;
  status: "pending" | "inflight" | "failed";
  capturedAt: number;
}

export interface RecentItem {
  contactId: string;
  name: string;
  company: string | null;
  outcome: string;
  capturedAt: number;
  expiresAt: number;
}

export interface TelemetryRecord {
  id: string;
  kind: "error" | "event";
  event: string;
  props: Record<string, unknown>;
  ts: number;
}

interface ExtDB extends DBSchema {
  capture_queue: {
    key: string;
    value: QueueItem;
    indexes: { by_status: string };
  };
  recent: {
    key: string;
    value: RecentItem;
  };
  telemetry: {
    key: string;
    value: TelemetryRecord;
  };
}

const DB_NAME = "truepoint-extension";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<ExtDB>> | null = null;

/** Open (memoised) the extension DB. The `upgrade` ladder is the version-migration seam (04 §4.4). */
export function db(): Promise<IDBPDatabase<ExtDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ExtDB>(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          const queue = database.createObjectStore("capture_queue", {
            keyPath: "idempotencyKey",
          });
          queue.createIndex("by_status", "status");
          database.createObjectStore("recent", { keyPath: "contactId" });
          database.createObjectStore("telemetry", { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}
