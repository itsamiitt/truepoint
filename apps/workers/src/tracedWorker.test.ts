import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { injectTraceContext, trace, withExtractedSpan, withSpan } from "@leadwolf/config";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { TRACE_CARRIER_KEY } from "./tracedWorker.ts";

/**
 * The point of tracing a worker is that a job continues the trace of whatever enqueued it. That linkage is
 * the part most likely to be silently wrong — a job still gets a span either way, so a broken carrier looks
 * exactly like a working one until someone opens a trace and finds two unrelated halves.
 *
 * Exercised through the propagation seam rather than a live BullMQ worker: what is under test is the context
 * plumbing, and a real queue would add Redis without testing anything more.
 */
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

// Registration mutates GLOBAL state and bun loads every test module before running any test, so it is scoped
// to this suite's execution window rather than module load.
beforeAll(() => provider.register());
afterEach(() => exporter.reset());
afterAll(() => {
  void provider.shutdown().catch(() => undefined);
  trace.disable();
});

describe("job trace propagation", () => {
  test("a job carrying a producer's context continues THAT trace", async () => {
    // Producer side: an API request stamps its context onto the payload.
    let carrier: Record<string, string> = {};
    let producerTraceId = "";
    await withSpan("api.request", { route: "/reveal" }, async (span) => {
      producerTraceId = span.spanContext().traceId;
      carrier = injectTraceContext();
    });
    expect(carrier.traceparent).toBeDefined();

    // Consumer side: the worker resumes from it.
    await withExtractedSpan(
      carrier,
      "worker.job.reveal",
      { "queue.name": "reveal" },
      async () => {},
    );

    const spans = exporter.getFinishedSpans();
    const job = spans.find((s) => s.name === "worker.job.reveal");
    expect(job?.spanContext().traceId).toBe(producerTraceId);
  });

  test("a job with NO carrier still gets a span — an untraced producer is not the worker's problem", async () => {
    await withExtractedSpan(
      undefined,
      "worker.job.scoring",
      { "queue.name": "scoring" },
      async () => {},
    );
    const job = exporter.getFinishedSpans().find((s) => s.name === "worker.job.scoring");
    expect(job).toBeDefined();
    expect(job?.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("a malformed carrier degrades to a fresh trace instead of throwing", async () => {
    // A hand-edited or truncated payload must not take the worker down.
    await withExtractedSpan(
      { traceparent: "garbage" },
      "worker.job.import",
      { "queue.name": "import" },
      async () => {},
    );
    expect(exporter.getFinishedSpans().find((s) => s.name === "worker.job.import")).toBeDefined();
  });

  test("two jobs from DIFFERENT producers do not end up in one trace", async () => {
    // Extraction is parented to ROOT, not the ambient context. Without that, whichever span happened to be
    // active when the worker picked up job B would adopt it — and every job would collapse into one trace.
    const carriers: Record<string, string>[] = [];
    for (const route of ["/a", "/b"]) {
      await withSpan("api.request", { route }, async () => carriers.push(injectTraceContext()));
    }
    await withExtractedSpan(carriers[0], "worker.job.one", {}, async () => {});
    await withExtractedSpan(carriers[1], "worker.job.two", {}, async () => {});

    const spans = exporter.getFinishedSpans();
    const one = spans.find((s) => s.name === "worker.job.one");
    const two = spans.find((s) => s.name === "worker.job.two");
    expect(one?.spanContext().traceId).not.toBe(two?.spanContext().traceId);
  });

  test("the carrier key is underscored, so it reads as transport rather than payload", () => {
    expect(TRACE_CARRIER_KEY).toBe("__trace");
  });
});
