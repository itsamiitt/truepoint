// types.ts — the shapes the System health area renders, mirroring the api `/admin/system-health` payload
// (apps/api/src/features/admin). Presentation-side only; the api owns the canonical shape.

export type ServiceStatus = "up" | "down" | "degraded" | "unknown";

export interface ServiceHealth {
  name: string;
  status: ServiceStatus;
}

export interface JobsHealth {
  sampleSize: number;
  truncated: boolean;
  byStatus: Record<string, number>;
  queueDepth: number;
  deadLetter: number;
}

/** One live BullMQ queue reading. Counts are null (NOT 0) when the queue was unreachable — an honest
 *  "unknown", never a fabricated empty queue. Mirrors the api QueueReport. */
export interface QueueReport {
  name: string;
  waiting: number | null;
  active: number | null;
  failed: number | null;
  delayed: number | null;
  workers: number | null;
  reachable: boolean;
}

export interface SystemHealth {
  services: ServiceHealth[];
  queues: QueueReport[];
  jobs: JobsHealth;
}
