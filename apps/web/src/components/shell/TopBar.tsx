// TopBar.tsx — the always-on top bar (11 §3): the section title at the left, the credit-balance pill at the
// right. Search + cmdk + notifications are post-MVP placeholders kept out of the chrome for now so the bar
// reads as the same quiet, monochrome system. The title is derived by the shell from the active route.
"use client";

import { CreditPill } from "./CreditPill";

export function TopBar({ title }: { title: string }) {
  return (
    <header className="tp-topbar">
      <h1 className="tp-topbar-title">{title}</h1>
      <div className="tp-topbar-right">
        <CreditPill />
      </div>
    </header>
  );
}
