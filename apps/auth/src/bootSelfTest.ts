// bootSelfTest.ts — node-only boot self-test. Imported by instrumentation.ts ONLY under the Node.js runtime
// (see the NEXT_RUNTIME guard there), so its ioredis-pulling transitive deps never reach the Edge bundle.
// Proves the JWT signing key can mint at startup and logs a FATAL line if it can't — deliberately NO
// process.exit (crash-looping auth would keep it unhealthy and block Caddy; deploy.sh's post-deploy smoke
// test is the hard gate). Never logs the PEM/token — only the error name/message.
import { assertSigningKey, log } from "@leadwolf/auth";

export async function runSigningKeySelfTest(): Promise<void> {
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
