// @forge/core capacity — P8 (17-scalability). A back-of-envelope volume → worker-sizing model so a phase can
// prove the 10× target. Pure; the real autoscaling topology (KEDA, pooler) is deploy-time (owned by 16/17).
export interface VolumeModel {
  capturesPerDay: number;
  avgPayloadBytes: number;
}

export interface StageThroughput {
  parsePerSec: number; // one worker's parse throughput
  extractPerSec: number; // AI-extract is seconds/call → far lower
  syncPerSec: number;
}

export interface CapacityPlan {
  capturesPerSec: number;
  parseWorkers: number;
  extractWorkers: number;
  syncWorkers: number;
  rawStorageBytesPerDay: number;
}

/** Size each stage's worker fleet from the capture rate and per-worker throughput (17 §volume model). */
export function capacityPlan(v: VolumeModel, tp: StageThroughput): CapacityPlan {
  const capturesPerSec = v.capturesPerDay / 86_400;
  const workers = (perSec: number): number =>
    Math.max(1, Math.ceil(capturesPerSec / Math.max(1e-9, perSec)));
  return {
    capturesPerSec,
    parseWorkers: workers(tp.parsePerSec),
    extractWorkers: workers(tp.extractPerSec),
    syncWorkers: workers(tp.syncPerSec),
    rawStorageBytesPerDay: v.capturesPerDay * v.avgPayloadBytes,
  };
}
