"use client";
// GlobalSearch.tsx — the top-bar global search affordance. It's a quiet button that opens the command palette
// (the palette owns the actual searching); clicking dispatches "command:open", which CommandPalette listens for.
//
// A DS TpButton wearing the local `tp-global-search` skin rather than a raw <button> re-deriving one. The
// bespoke class is declared in globals.css AFTER its `@import "@leadwolf/ui/primitives.css"` and at the same
// (0,1,0) specificity, so it still wins every property it sets — the 32px height, min-width, surface-2 fill
// and `cursor: text` that make this read as a search field rather than a button.
import { Icon, TpButton } from "@leadwolf/ui";
import { Search } from "lucide-react";

export function GlobalSearch() {
  const open = () => window.dispatchEvent(new CustomEvent("command:open"));
  return (
    <TpButton
      variant="ghost"
      className="tp-global-search"
      onClick={open}
      aria-label="Search (Cmd/Ctrl + K)"
      leftIcon={<Icon icon={Search} size={15} />}
    >
      <span className="tp-global-search-text">Search…</span>
    </TpButton>
  );
}
