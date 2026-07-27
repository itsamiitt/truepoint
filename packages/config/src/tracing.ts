// tracing.ts — the tracing seam (E-6.5). One place every layer reaches for a span, so api, workers and db
// produce a single connected trace instead of three unrelated ones.
//
// It lives in @leadwolf/config for a boundary reason, not a stylistic one: `@leadwolf/db` may depend only on
// config and types, so a seam anywhere else could not be used by the layer whose latency matters most.
//
// Only `@opentelemetry/api` is imported here, and that package is a NO-OP by design — with no SDK registered
// it hands back a non-recording span whose methods do nothing. So this file costs nothing until an app
// entrypoint installs an SDK, which it only does when an endpoint is configured. That is what lets the
// instrumentation live in shared code without every process paying for telemetry it does not emit.

import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";

/** One tracer for the whole platform; the span name carries the layer, so a second tracer buys nothing. */
const tracer = trace.getTracer("leadwolf");

/** Attributes worth attaching. Deliberately NOT a free-form record: see the note on tenant ids below. */
export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

/**
 * Run `fn` inside a span, recording an exception + error status if it throws.
 *
 * Rethrows always. Instrumentation that swallows is worse than none — it turns a failure into a silent
 * success, and the trace then shows a healthy request that did nothing.
 *
 * NEVER put PII in `attributes`. Tenant and workspace IDs are fine and useful (they are opaque uuids and the
 * whole point is per-tenant latency); email addresses, names, phone numbers and search text are not — a trace
 * backend is a second copy of production data with its own retention and access rules
 * (truepoint-security data-protection).
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** The active trace/span ids, for stamping a log line so a log and its trace can be joined. Empty when no SDK
 *  is registered — callers should treat that as "no trace", not as an error. */
export function activeTraceIds(): { traceId: string; spanId: string } | null {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx?.traceId ? { traceId: ctx.traceId, spanId: ctx.spanId } : null;
}

export { trace, SpanStatusCode };
export type { Span };
