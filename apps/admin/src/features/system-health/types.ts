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

export interface SystemHealth {
  services: ServiceHealth[];
  jobs: JobsHealth;
}
