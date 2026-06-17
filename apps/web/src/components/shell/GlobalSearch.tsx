"use client";
// GlobalSearch.tsx — the top-bar global search affordance. It's a quiet button that opens the command palette
// (the palette owns the actual searching); clicking dispatches "command:open", which CommandPalette listens for.
import { Icon } from "@leadwolf/ui";
import { Search } from "lucide-react";

export function GlobalSearch() {
  const open = () => window.dispatchEvent(new CustomEvent("command:open"));
  return (
    <button
      type="button"
      className="tp-global-search"
      onClick={open}
      aria-label="Search (Cmd/Ctrl + K)"
    >
      <Icon icon={Search} size={15} />
      <span className="tp-global-search-text">Search…</span>
    </button>
  );
}
