// CreditsTab.tsx — the billing hub's Credits tab: the credit-pool balance, a low-balance hint, the Stripe
// top-up (toasts "coming soon" until checkout is wired), and the transparent-billing reassurance. Purchase is
// gated to workspace-admins (OD-8) via `canPurchase`; a member sees a read-only hint instead of the button.
"use client";

import { Card, StatusBadge, TpButton, useToast } from "@leadwolf/ui";
import { CreditCard, Wallet } from "lucide-react";
import { useState } from "react";
import styles from "../../billing.module.css";

/** The default top-up pack — packs/pricing are server-driven; this is only the checkout seed. */
const TOPUP_PACK = "pack_500";
/** Mirror the shell CreditPill's amber-at-<20 low-balance signal. */
const LOW_BALANCE_THRESHOLD = 20;

export function CreditsTab({
  balance,
  topUp,
  canPurchase = true,
}: {
  balance: number | null;
  topUp: (pack: string) => Promise<string | null>;
  canPurchase?: boolean;
}) {
  const toast = useToast();
  const [toppingUp, setToppingUp] = useState(false);
  const bal = balance ?? 0;
  const low = balance != null && bal < LOW_BALANCE_THRESHOLD;

  const onTopUp = async () => {
    setToppingUp(true);
    try {
      const url = await topUp(TOPUP_PACK);
      if (url) window.location.assign(url);
      else
        toast.toast({
          title: "Top-up coming soon",
          description: "Stripe checkout isn't wired yet — credits top up here once it ships.",
        });
    } catch (e) {
      toast.error("Could not start checkout", e instanceof Error ? e.message : undefined);
    } finally {
      setToppingUp(false);
    }
  };

  return (
    <Card style={{ padding: 24 }}>
      <div className={styles.cardHead}>
        <span className={styles.cardLabel}>
          <Wallet size={14} aria-hidden />
          Credit balance
        </span>
        {low && <StatusBadge tone="warning">Low balance</StatusBadge>}
      </div>
      <div className={styles.balanceRow}>
        <div>
          <span className={styles.balanceNumber}>{bal.toLocaleString()}</span>
          <span className={styles.balanceUnit}>credits available</span>
        </div>
        {canPurchase ? (
          <TpButton
            variant="secondary"
            leftIcon={<CreditCard size={15} />}
            loading={toppingUp}
            onClick={onTopUp}
          >
            Top up
          </TpButton>
        ) : (
          <span className={styles.mutedHint}>Ask a workspace admin to top up</span>
        )}
      </div>
      <p className={styles.note}>
        <span className={styles.noteDot} aria-hidden="true" />
        <span>
          You&apos;re only charged for verified data; bounces are credited back. Credits never
          expire.
        </span>
      </p>
    </Card>
  );
}
