import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { activeTraceIds, trace, withSpan } from "@leadwolf/config";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { telemetryEnabled } from "./telemetry.ts";

/**
 * A collector is needed to DELIVER spans; it is not needed to prove they are produced correctly. An in-memory
 * exporter records them in-process, so the two things most likely to be wrong — the span shape and the
 * parent/child nesting that makes a trace readable — are verified here rather than discovered in a UI later.
 */
const exporter = new InMemorySpanExporter();
// NodeTracerProvider, not BasicTracerProvider: `register()` moved off the base class in OTel 2.x, and the
// registration is the point — without it `withSpan` keeps handing back the no-op span.
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

// Registered in beforeAll rather than at module scope, and torn down after. Registration mutates GLOBAL
// state, and bun LOADS every test module before running any test — so a top-level `register()` here is
// already in effect while other files run. That broke packages/config's tracing.test.ts, whose whole subject
// is the UNREGISTERED no-op path: it failed in a file that never mentions telemetry. Confining the
// registration to this suite's execution window keeps the global clean for everyone else.
beforeAll(() => provider.register());

afterEach(() => exporter.reset());

// Registering a tracer provider mutates GLOBAL state, and bun runs every test file in one process locally
// (CI shards per file, so this only bites on a full local run). Without this teardown the provider leaks into
// packages/config's tracing.test.ts, whose whole point is asserting the UNREGISTERED no-op behaviour — it
// would fail there, in a file that never mentions telemetry.
afterAll(() => {
  void provider.shutdown().catch(() => undefined);
  trace.disable();
});

describe("startTelemetry", () => {
  test("stays OFF without an endpoint — the shipped default", () => {
    // No OTEL_EXPORTER_OTLP_ENDPOINT in the test env, so the app registers nothing. `withSpan` then costs
    // what the OTel API's no-op costs, which is the argument for putting it in shared code at all.
    expect(telemetryEnabled()).toBe(false);
  });
});

describe("withSpan, with a provider registered", () => {
  test("emits a span carrying the tenant attributes", async () => {
    await withSpan("db.tenant.tx", { "tenant.id": "t-1", "workspace.id": "w-1" }, async () => "ok");

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("db.tenant.tx");
    expect(span?.attributes["tenant.id"]).toBe("t-1");
    expect(span?.attributes["workspace.id"]).toBe("w-1");
  });

  test("an undefined attribute is OMITTED, not recorded as a string", async () => {
    // workspace.id is genuinely absent on tenant-scoped work. Recording "undefined" would make those spans
    // look attributed to a workspace that does not exist.
    await withSpan(
      "db.tenant.tx",
      { "tenant.id": "t-1", "workspace.id": undefined },
      async () => 1,
    );
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes).not.toHaveProperty("workspace.id");
  });

  test("nests child spans under the active one — this is what makes a trace a trace", async () => {
    await withSpan("api.request", { route: "/reports" }, async () => {
      await withSpan("db.replica.tx", { "tenant.id": "t-1" }, async () => "rows");
    });

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "api.request");
    const child = spans.find((s) => s.name === "db.replica.tx");
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
    // Same trace, or they are two unrelated traces that happen to be adjacent in time.
    expect(child?.spanContext().traceId).toBe(parent?.spanContext().traceId as string);
  });

  test("exposes the active trace ids, so a log line can be joined to its trace", async () => {
    // The counterpart to the no-op case: with a provider registered these must be real ids, or the whole
    // point of stamping logs with them is lost.
    expect(activeTraceIds()).toBeNull(); // outside any span
    await withSpan("api.request", {}, async () => {
      const ids = activeTraceIds();
      expect(ids?.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(ids?.spanId).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  test("records the exception and marks the span an ERROR, then rethrows", async () => {
    // The rethrow is the load-bearing half: a swallowed failure would show as a healthy span AND let the
    // caller continue as though the work succeeded.
    await expect(
      withSpan("db.tenant.tx", { "tenant.id": "t-1" }, async () => {
        throw new Error("connection reset");
      }),
    ).rejects.toThrow("connection reset");

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  });
});
