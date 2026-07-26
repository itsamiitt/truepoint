// lifecycle.ts — process-level drain state, shared by the server entry (which flips it on SIGTERM) and the
// readiness endpoint in app.ts (which must fail while draining so the orchestrator stops routing to us).
//
// It lives in its own module for exactly one reason: server.ts imports app.ts, so app.ts cannot import
// server.ts back without creating the import cycle `no-circular` (.dependency-cruiser.cjs) fails the build on.

let draining = false;

/** True once a SIGTERM/SIGINT drain has begun. Readiness must report NOT-ready from this moment. */
export function isDraining(): boolean {
  return draining;
}

/** Called once by the signal handler in server.ts. Idempotent; returns false if a drain is already running. */
export function beginDraining(): boolean {
  if (draining) return false;
  draining = true;
  return true;
}
