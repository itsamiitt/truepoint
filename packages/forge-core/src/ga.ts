// @forge/core GA — P9 (14 §11, ADR-0046). Take Forge to GA behind a per-tenant canary. Capture (P1) and sync
// (P6) stay DARK until the GA-blocking LEGAL sign-off (OQ-2) is complete; the flip is PER TENANT, never global
// (G-FORGE-1905), behind a metric-gated canary that auto-rolls-back on SLO regression [S112]. Pure — the DPIA/
// LIA/declaration are calendar/legal work (not code); this encodes the gate they unlock.

export interface GaReadiness {
  dpiaSigned: boolean; // Data Protection Impact Assessment (OQ-2, GA-blocking)
  liaSigned: boolean; // Legitimate-Interest Assessment (Art 6(1)(f))
  art14NoticeReady: boolean; // GDPR Art 14 ≤1-month notice mechanism
  singlePurposeDeclared: boolean; // Chrome Web Store single-purpose declaration
  dpdpConsentPosture: boolean; // DPDP §7 for India-origin data (highest restriction)
  testsGreen: boolean; // the universal green gate held (main-agent-prompt §11)
  killSwitchArmed: boolean; // the global kill-switch can still stop the fleet
  darkConnectorRetired: boolean; // TruePoint chrome_extension connector retired (OQ-5)
}

export interface GaGateResult {
  ready: boolean;
  blockers: string[];
}

/** GA is blocked until EVERY precondition holds — legal sign-off is not a planning decision (OQ-2). */
export function evaluateGaReadiness(r: GaReadiness): GaGateResult {
  const blockers: string[] = [];
  if (!r.dpiaSigned) blockers.push("dpia_unsigned");
  if (!r.liaSigned) blockers.push("lia_unsigned");
  if (!r.art14NoticeReady) blockers.push("art14_notice_missing");
  if (!r.singlePurposeDeclared) blockers.push("single_purpose_undeclared");
  if (!r.dpdpConsentPosture) blockers.push("dpdp_consent_missing");
  if (!r.testsGreen) blockers.push("tests_red");
  if (!r.killSwitchArmed) blockers.push("kill_switch_unarmed");
  if (!r.darkConnectorRetired) blockers.push("dark_connector_not_retired");
  return { ready: blockers.length === 0, blockers };
}

// ── per-tenant canary enablement (never global, G-FORGE-1905) ─────────────────────────────────────────
export interface CanaryState {
  enabledTenants: Set<string>;
}

export function newCanaryState(): CanaryState {
  return { enabledTenants: new Set() };
}

/** Flip capture+sync live for ONE tenant — only once the GA gate is green (never global). */
export function enableTenant(
  state: CanaryState,
  tenantId: string,
  gate: GaGateResult,
): { enabled: boolean; reason?: string } {
  if (!gate.ready) return { enabled: false, reason: "ga_not_ready" };
  state.enabledTenants.add(tenantId);
  return { enabled: true };
}

export function isLiveForTenant(state: CanaryState, tenantId: string): boolean {
  return state.enabledTenants.has(tenantId);
}

// ── metric-gated canary auto-rollback [S112] ──────────────────────────────────────────────────────────
export interface CanaryMetrics {
  errorRate: number; // 0..1
  freshnessBreaches: number; // count in the observation window
}
export interface CanaryThresholds {
  maxErrorRate: number;
  maxFreshnessBreaches: number;
}
export type CanaryDecision = "proceed" | "rollback";

/** Auto-roll-back the canary on any SLO regression; the kill-switch is the operator's manual backstop. */
export function canaryDecision(m: CanaryMetrics, t: CanaryThresholds): CanaryDecision {
  return m.errorRate > t.maxErrorRate || m.freshnessBreaches > t.maxFreshnessBreaches
    ? "rollback"
    : "proceed";
}
