// logger.ts — minimal structured (JSON-line) logger for the workers process: one JSON object per line
// ({ ts, level, msg, ...fields }) so a log shipper can parse it. No dependency. info/warn go to stdout,
// error to stderr so orchestrators can split the streams. Never log PII (job payloads / raw rows).

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
