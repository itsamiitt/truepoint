// log.ts — minimal structured (JSON-line) logger for the auth primitives + the auth app that consumes them
// ({ ts, level, msg, ...fields } per line, so a shipper can parse it). No dependency. info/warn → stdout,
// error → stderr so orchestrators can split the streams. NEVER log secrets or PII: no codes, tokens,
// verifiers, passwords, or raw client IPs — log the failing reason, not the offending value. (Mirrors
// apps/workers/src/logger.ts; lives here so the auth package and the auth app share one logger.)

type Level = "info" | "warn" | "error";

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
