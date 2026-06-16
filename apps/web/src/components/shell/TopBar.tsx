// TopBar.tsx — the always-on top bar (11 §3): the section title at the left; on the right a subtle Cmd/Ctrl-K
// command-palette hint, the notifications bell, and the credit-balance pill. The bar stays quiet + monochrome
// so every destination reads as the same system. The title is derived by the shell from the active route.
"use client";

import { useEffect, useState } from "react";
import { CreditPill } from "./CreditPill";
import { NotificationsBell } from "./NotificationsBell";
import styles from "./TopBar.module.css";

/** A quiet, non-interactive hint that Cmd/Ctrl-K opens the palette; shows ⌘ on Mac, Ctrl elsewhere. */
function CommandHint() {
  const [mac, setMac] = useState(false);
  useEffect(() => {
    setMac(/mac/i.test(navigator.platform));
  }, []);
  return (
    <span className={styles.hint} aria-hidden="true">
      <kbd className={styles.key}>{mac ? "⌘" : "Ctrl"}</kbd>
      <kbd className={styles.key}>K</kbd>
    </span>
  );
}

export function TopBar({ title }: { title: string }) {
  return (
    <header className="tp-topbar">
      <h1 className="tp-topbar-title">{title}</h1>
      <div className="tp-topbar-right">
        <CommandHint />
        <NotificationsBell />
        <CreditPill />
      </div>
    </header>
  );
}
