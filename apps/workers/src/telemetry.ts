// telemetry.ts — registers the OpenTelemetry SDK, and ONLY when an OTLP endpoint is configured (E-6.5).
//
// The tracing seam itself lives in @leadwolf/config and is a no-op until something registers a provider. This
// is that registration, kept in the app entrypoint rather than the shared package for a reason: a library
// that installs a global tracer provider on import decides telemetry policy for every process that happens to
// import it, including tests and one-shot scripts. The decision belongs to the process, at boot.
//
// Deliberately NOT auto-instrumentation. The spans that matter here are the ones the code already knows are
// meaningful — a scoped DB transaction, a queue job — and those are explicit `withSpan` calls. Wholesale HTTP
// and socket patching would bury them in noise and pull in a far larger dependency surface.

import { env } from "@leadwolf/config";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

let provider: NodeTracerProvider | null = null;

/** True once a provider is registered — i.e. spans are actually being recorded and exported. */
export function telemetryEnabled(): boolean {
  return provider !== null;
}

/**
 * Register the tracer provider if an endpoint is configured. Idempotent, and safe to call before the server
 * listens — a second call is ignored rather than stacking a second exporter onto the same spans.
 */
export function startTelemetry(): void {
  if (provider || !env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME_WORKERS }),
    // Batched, not simple: a span per request exported synchronously would put the collector's latency on the
    // request path, which is the opposite of what tracing is for.
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
}

/** Flush pending spans on shutdown. Without this the last batch dies with the process — and the spans most
 *  worth having are usually the ones from just before it went down. */
export async function stopTelemetry(): Promise<void> {
  if (!provider) return;
  await provider.shutdown().catch(() => undefined);
  provider = null;
}
