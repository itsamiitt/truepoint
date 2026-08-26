// DatabaseProfileRevealActions.tsx — the person profile's channel row: reveal IS the save gesture (decisions.md
// 2026-08-25). For each channel the person carries, either the revealed VALUE (when this workspace owns it) or
// a "Reveal email · Ncr" button that materializes the person AND reveals in one request. There is no "Add to
// workspace" here any more — no free path into the workspace from Search, by decision. Reads the same
// RevealStore the grid does (through the prospect slice's entry), so a reveal made here and one made in the
// grid never disagree.
"use client";

import {
  ownedRevealTypes,
  useDatabaseRevealEnabled,
  useIsRevealing,
  useRevealCosts,
  useRevealStore,
  useRevealedContact,
} from "@/features/prospect/entries/revealStore";
import type { MaskedDatabasePerson } from "@leadwolf/types";
import { StatusBadge, TpButton, TpChip, useToast } from "@leadwolf/ui";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import styles from "../accounts.module.css";

const IN_PROGRESS = "A reveal is already in progress.";

export function DatabaseProfileRevealActions({
  slug,
  person,
  onMaterialized,
}: {
  slug: string;
  person: MaskedDatabasePerson;
  /** The person became (or already was) a workspace contact — let the composer refresh the grid. */
  onMaterialized: (slug: string) => void;
}) {
  const store = useRevealStore();
  const toast = useToast();
  const costs = useRevealCosts();
  const enabled = useDatabaseRevealEnabled();
  // Saved in THIS drawer session — the profile query still says "not in workspace" until it refetches.
  const [savedId, setSavedId] = useState<string | null>(null);
  const contactId = person.inWorkspace?.contactId ?? savedId;
  const revealed = useRevealedContact(contactId ?? "");
  // The store keys an in-flight reveal-as-save by the grid's row id for the person (`db:<slug>`).
  const emailBusy = useIsRevealing(`db:${slug}`, "email");
  const phoneBusy = useIsRevealing(`db:${slug}`, "phone");

  // A person the workspace already holds: hydrate what it owns, so the values show without a charge.
  useEffect(() => {
    if (contactId) store.hydrate([contactId]);
  }, [contactId, store]);

  const owned = ownedRevealTypes(undefined, revealed);

  const reveal = async (type: "email" | "phone") => {
    const label = type === "email" ? "Email" : "Phone";
    const res = await store.revealFromDatabase(slug, type);
    // The landing commits before the reveal runs: a contactId means the person IS saved, success or not.
    if (res.contactId) {
      setSavedId(res.contactId);
      onMaterialized(slug);
    }
    if (res.ok && res.result) {
      if (res.result.nothingToReveal) {
        toast.success(
          "Saved to your workspace",
          `No ${label.toLowerCase()} on file — nothing was charged.`,
        );
      } else {
        const n = res.result.creditsCharged;
        toast.success(
          `${label} revealed · saved to your workspace`,
          res.result.alreadyOwned
            ? "Already owned — no credits charged."
            : `Charged ${n} credit${n === 1 ? "" : "s"}.`,
        );
      }
    } else if (res.error && res.error !== IN_PROGRESS) {
      toast.error(
        res.contactId
          ? "Saved to your workspace — reveal failed"
          : res.code === "insufficient_credits"
            ? "Not enough credits"
            : "Reveal failed",
        res.error,
      );
    }
  };

  return (
    <section className={styles.profileSection} aria-label="Contact channels">
      {contactId ? (
        <div className={styles.presenceRow}>
          <TpChip active>Saved to your workspace</TpChip>
        </div>
      ) : null}
      <ChannelLine
        label="Email"
        present={person.hasEmail}
        value={owned.email ? (revealed?.email ?? null) : null}
        status={revealed?.emailStatus ?? null}
        cost={costs?.email ?? null}
        enabled={enabled}
        busy={emailBusy}
        onReveal={() => void reveal("email")}
      />
      <ChannelLine
        label="Phone"
        present={person.hasPhone}
        value={owned.phone ? (revealed?.phone ?? null) : null}
        status={revealed?.phoneLineType ?? null}
        cost={costs?.phone ?? null}
        enabled={enabled}
        busy={phoneBusy}
        onReveal={() => void reveal("phone")}
      />
    </section>
  );
}

function ChannelLine({
  label,
  present,
  value,
  status,
  cost,
  enabled,
  busy,
  onReveal,
}: {
  label: "Email" | "Phone";
  present: boolean;
  value: string | null;
  status: string | null;
  cost: number | null;
  enabled: boolean;
  busy: boolean;
  onReveal: () => void;
}) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {value ? (
        <span className={styles.fieldValue}>
          {value}
          {status ? (
            <>
              {" "}
              <StatusBadge tone="muted">{status}</StatusBadge>
            </>
          ) : null}
        </span>
      ) : !present ? (
        <span className={styles.profileSub}>Not on file</span>
      ) : !enabled ? (
        <span className={styles.profileSub}>
          On file — revealing from the database isn't enabled yet
        </span>
      ) : (
        <TpButton
          size="sm"
          variant="secondary"
          loading={busy}
          leftIcon={<Sparkles size={13} />}
          onClick={onReveal}
        >
          Reveal {label.toLowerCase()}
          {cost != null ? ` · ${cost}cr` : ""}
        </TpButton>
      )}
    </div>
  );
}
