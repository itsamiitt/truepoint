// SignalsPage.tsx — the Signals destination (market-intelligence MI-P2, 07-product-surfaces §3):
// the workspace signal feed (family-filtered lens over tenant_signals) + the watchlists panel
// (create/delete lists, per-user family subscriptions). Honest empty states: the feed is empty until the
// fan-out pipeline is enabled and licensed sources land signals — the page says so instead of pretending.
// Presentation + view state only (useSignals → api); four-state via StateSwitch.
"use client";

import type { SignalFamily, TenantSignal, Watchlist } from "@leadwolf/types";
import {
  EmptyState,
  PageHeader,
  StateSwitch,
  StatusBadge,
  type TabItem,
  Tabs,
  TpButton,
  TpInput,
} from "@leadwolf/ui";
import Link from "next/link";
import { useState } from "react";
import { useSignalFeed, useWatchlists } from "../hooks/useSignals";
import styles from "../signals.module.css";

const FAMILIES: Array<{ key: SignalFamily | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "leadership", label: "Leadership" },
  { key: "hiring", label: "Hiring" },
  { key: "funding", label: "Funding" },
  { key: "tech_change", label: "Technology" },
  { key: "filing", label: "Filings" },
  { key: "other", label: "Other" },
];

/** The same seven options, shaped for the DS <Tabs> (which the feed filter already declared itself to be). */
const FAMILY_TABS: TabItem[] = FAMILIES.map((f) => ({ value: f.key, label: f.label }));

type Tone = "success" | "warning" | "muted";
const FAMILY_TONE: Record<SignalFamily, Tone> = {
  leadership: "warning",
  hiring: "success",
  funding: "success",
  tech_change: "muted",
  filing: "muted",
  other: "muted",
};

const FAMILY_LABEL: Record<SignalFamily, string> = {
  leadership: "Leadership",
  hiring: "Hiring",
  funding: "Funding",
  tech_change: "Technology",
  filing: "Filing",
  other: "Signal",
};

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const m = Math.floor((Date.now() - then) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function SignalRow({ signal }: { signal: TenantSignal }) {
  const title = signal.headline ?? `${FAMILY_LABEL[signal.family]} change`;
  return (
    <li className={styles.item}>
      <StatusBadge tone={FAMILY_TONE[signal.family]}>{FAMILY_LABEL[signal.family]}</StatusBadge>
      <span className={styles.headline}>
        {signal.accountId ? <Link href={`/companies/${signal.accountId}`}>{title}</Link> : title}
      </span>
      <span className={styles.time}>{relTime(signal.observedAt)}</span>
    </li>
  );
}

function WatchlistsPanel() {
  const { watchlists, loading, error, create, remove, subscribe, reload } = useWatchlists();
  const [name, setName] = useState("");
  const [subs, setSubs] = useState<Record<string, Set<SignalFamily>>>({});

  // Server truth (w.myFamilies) hydrates the toggles; local state only overrides after a toggle in this
  // session, so a reload always shows what is actually persisted.
  const toggleFamily = (w: Watchlist, family: SignalFamily) => {
    setSubs((prev) => {
      const current = new Set(prev[w.id] ?? w.myFamilies);
      if (current.has(family)) current.delete(family);
      else current.add(family);
      subscribe.mutate({ watchlistId: w.id, families: [...current] });
      return { ...prev, [w.id]: current };
    });
  };

  return (
    <aside className={styles.panel}>
      <h2 className={styles.panelTitle}>Watchlists</h2>
      <StateSwitch
        loading={loading}
        error={error}
        onRetry={reload}
        empty={watchlists.length === 0}
        emptyState={
          <EmptyState
            title="No watchlists yet"
            description="Create one, then add accounts from search or the account view."
          />
        }
      >
        <div>
          {watchlists.map((w) => (
            <div key={w.id}>
              <div className={styles.watchlistRow}>
                <span className={styles.watchlistName}>{w.name}</span>
                <span className={styles.memberCount}>
                  {w.memberCount} {w.memberCount === 1 ? "account" : "accounts"}
                </span>
                <TpButton variant="ghost" size="sm" onClick={() => remove.mutate(w.id)}>
                  Delete
                </TpButton>
              </div>
              <div className={styles.familyToggles}>
                {/* Deliberately a raw <button> and not TpChip: these are MULTI-select subscription toggles,
                    and their state is announced by aria-pressed. TpChip renders its label inside a wrapper
                    <span> with no pressed state to pass through, so converting would leave the on/off state
                    conveyed by the pill colour alone. It carries type="button" and its label is its name. */}
                {FAMILIES.filter((f) => f.key !== "all").map((f) => {
                  const effective = subs[w.id] ?? new Set<SignalFamily>(w.myFamilies);
                  const active = effective.has(f.key as SignalFamily);
                  return (
                    <button
                      key={f.key}
                      type="button"
                      className={active ? styles.chipActive : styles.chip}
                      aria-pressed={active}
                      onClick={() => toggleFamily(w, f.key as SignalFamily)}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </StateSwitch>
      <form
        className={styles.newForm}
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          create.mutate(trimmed, { onSuccess: () => setName("") });
        }}
      >
        <TpInput
          className={styles.newInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New watchlist name"
          aria-label="New watchlist name"
          maxLength={120}
        />
        <TpButton type="submit" variant="secondary" size="sm" disabled={!name.trim()}>
          Create
        </TpButton>
      </form>
    </aside>
  );
}

export function SignalsPage() {
  const { signals, family, setFamily, loading, error, reload } = useSignalFeed();

  return (
    <section>
      {/* PageHeader, not the borrowed .tp-settings-title: this is a destination, not a settings panel. The
          feature's .head keeps the 16px gap to the layout below (PageHeader's own margin is 0). */}
      <PageHeader className={styles.head} title="Signals" />
      <div className={styles.layout}>
        <div>
          {/* The DS Tabs — the filter row was ALREADY a hand-rolled role="tablist"/role="tab", but without
              the pattern's other half: no roving tabindex and no arrow keys, so it was Tab-only. Tabs ships
              both. .filters still carries the row's gap + 12px bottom margin. */}
          <Tabs
            className={styles.filters}
            items={FAMILY_TABS}
            value={family}
            onChange={(v) => setFamily(v as SignalFamily | "all")}
            aria-label="Signal family"
          />
          <StateSwitch
            loading={loading}
            error={error}
            onRetry={reload}
            empty={signals.length === 0}
            emptyState={
              <EmptyState
                title="No signals yet"
                description="Signals appear here when events land for accounts in this workspace — leadership changes, headcount moves, funding. Watch accounts and subscribe on a watchlist to get notified."
              />
            }
          >
            <ul className={styles.list}>
              {signals.map((s) => (
                <SignalRow key={s.id} signal={s} />
              ))}
            </ul>
          </StateSwitch>
        </div>
        <WatchlistsPanel />
      </div>
    </section>
  );
}
