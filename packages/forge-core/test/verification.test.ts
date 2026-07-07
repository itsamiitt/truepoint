import { describe, expect, test } from "bun:test";
import {
  type ApprovalRequest,
  FourEyesViolationError,
  type PromotionCandidate,
  type PromotionTx,
  approvePromotion,
  canonicalizeAuditRow,
  computePriority,
  forgeAuditHash,
  verifyAuditChain,
} from "../src/index.ts";

function fakeTx(seen = new Set<string>()) {
  const promoted: string[] = [];
  const tx: PromotionTx = {
    promote: async ({ candidate }) => {
      if (seen.has(candidate.contentHash)) return { verifiedId: "v-existing", written: false };
      seen.add(candidate.contentHash);
      promoted.push(candidate.contentHash);
      return { verifiedId: `v-${candidate.contentHash}`, written: true };
    },
  };
  return { tx, promoted };
}

const candidate = (contentHash: string, confidence: number): PromotionCandidate => ({
  contentHash,
  entityKind: "person",
  fields: {},
  confidence,
});

describe("four-eyes promotion gate (10 §5)", () => {
  test("checker == maker → FourEyesViolationError; nothing promoted", async () => {
    const { tx, promoted } = fakeTx();
    const req: ApprovalRequest = {
      id: "a1",
      requestedByUserId: "u1",
      candidates: [candidate("h1", 0.95)],
    };
    await expect(approvePromotion(tx, req, "u1")).rejects.toBeInstanceOf(FourEyesViolationError);
    expect(promoted).toHaveLength(0);
  });

  test("a below-threshold candidate cannot promote (blocked)", async () => {
    const { tx, promoted } = fakeTx();
    const req: ApprovalRequest = {
      id: "a1",
      requestedByUserId: "maker",
      candidates: [candidate("h1", 0.5), candidate("h2", 0.95)],
    };
    const r = await approvePromotion(tx, req, "checker");
    expect(r.approved).toBe(1);
    expect(r.blocked).toBe(1);
    expect(promoted).toEqual(["h2"]);
    expect(r.items.find((i) => i.contentHash === "h1")?.status).toBe("blocked");
  });

  test("a replayed approval is an idempotent duplicate no-op", async () => {
    const seen = new Set<string>();
    const req: ApprovalRequest = {
      id: "a1",
      requestedByUserId: "maker",
      candidates: [candidate("h1", 0.95)],
    };
    await approvePromotion(fakeTx(seen).tx, req, "checker");
    const r = await approvePromotion(fakeTx(seen).tx, req, "checker");
    expect(r.approved).toBe(0);
    expect(r.duplicate).toBe(1);
  });
});

describe("review queue prioritization (10 §2)", () => {
  test("lower confidence ranks higher (uncertainty first, not FIFO)", () => {
    const uncertain = computePriority({ confidence: 0.1, value: 0.5, freshness: 0.5, risk: 0.5 });
    const confident = computePriority({ confidence: 0.9, value: 0.5, freshness: 0.5, risk: 0.5 });
    expect(uncertain).toBeGreaterThan(confident);
  });
});

describe("hash-chained audit (10 §7)", () => {
  test("a valid chain verifies; a tampered row fails", () => {
    const rows: Array<{ prevHash: string; rowHash: string; canonical: string }> = [];
    let prev = "GENESIS";
    for (const action of ["review.approved", "verify.promoted"]) {
      const canonical = canonicalizeAuditRow({
        action,
        actorKind: "human",
        actorId: "u1",
        payload: { x: 1 },
      });
      const rowHash = forgeAuditHash(prev, canonical);
      rows.push({ prevHash: prev, rowHash, canonical });
      prev = rowHash;
    }
    expect(verifyAuditChain(rows)).toBe(true);

    const tampered = rows[1];
    if (tampered) {
      tampered.canonical = canonicalizeAuditRow({
        action: "verify.promoted",
        actorKind: "human",
        actorId: "ATTACKER",
        payload: { x: 1 },
      });
    }
    expect(verifyAuditChain(rows)).toBe(false);
  });
});
