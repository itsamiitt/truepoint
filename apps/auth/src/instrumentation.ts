// instrumentation.ts — Next.js boot hook (Next 15: stable, no experimental flag). The JWT signing self-test
// lives in a SEPARATE node-only module imported ONLY under the Node.js runtime: this app's middleware forces
// an Edge compilation too, and the self-test transitively pulls ioredis (Node built-ins like net/dns/stream)
// which the Edge runtime can't bundle. Gating the dynamic import on NEXT_RUNTIME === "nodejs" keeps it (and
// ioredis) out of the Edge bundle — the documented Next.js pattern for runtime-specific instrumentation.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runSigningKeySelfTest } = await import("./bootSelfTest.ts");
    await runSigningKeySelfTest();
  }
}
