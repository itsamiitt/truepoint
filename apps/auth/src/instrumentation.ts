// instrumentation.ts — Next.js boot hook (Next 15: stable, no experimental flag needed). On the Node.js
// runtime, run the JWT signing self-test at startup so a missing/garbled key surfaces as one FATAL
// structured line in `docker logs auth` (ADR-0016 addendum), instead of every sign-in silently 503-ing
// (token_mint_failed). We deliberately do NOT process.exit: crash-looping auth would keep it unhealthy and
// block Caddy (depends_on: auth service_healthy), taking the whole stack down — deploy.sh's post-deploy
// smoke test is the hard gate that fails the deploy. Never logs the PEM/token — only the error name/message.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertSigningKey, log } = await import("@leadwolf/auth");
  try {
    await assertSigningKey();
    log.info("auth.boot.signing_key_ok");
  } catch (err) {
    log.error("auth.boot.FATAL.signing_key_unavailable", {
      err: err instanceof Error ? err.name : "unknown",
      message: err instanceof Error ? err.message : "unknown",
    });
  }
}
