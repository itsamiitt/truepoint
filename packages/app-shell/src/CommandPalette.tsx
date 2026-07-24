// CommandPalette.tsx — the global Cmd/Ctrl-K palette. Mounted once by the frame; a cmdk dialog over the
// destinations the app passes in. It owns no data and no auth: navigation goes through the router, and sign-out
// plus any app-specific rows arrive as props, so the staff consoles get the same launcher without inheriting
// web's account actions. Also opens on a "command:open" event (web's top-bar global search dispatches it).
//
// Styling is global .tp-palette-* classes in shell.css rather than a CSS module, because a CSS-module import
// from a package would force every consuming app into extra Next transpile configuration.
"use client";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "cmdk";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { PaletteEntry } from "./nav.ts";

export interface PaletteAction {
  id: string;
  label: string;
  keywords?: string[];
  onSelect: () => void;
}

export function CommandPalette({
  navigate,
  quick = [],
  actions = [],
  placeholder = "Type a command or search…",
}: {
  /** Destinations to jump to — usually paletteEntriesFrom(DESTINATIONS). */
  navigate: PaletteEntry[];
  /** Optional second navigation group (web's quick links). */
  quick?: PaletteEntry[];
  /** Non-navigation rows (switch workspace, sign out). */
  actions?: PaletteAction[];
  placeholder?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Global toggle: Cmd/Ctrl-K toggles the palette; "command:open" (the top-bar search) opens it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("command:open", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("command:open", onOpen);
    };
  }, []);

  const go = useCallback(
    (entry: PaletteEntry) => {
      setOpen(false);
      router.push(entry.href);
    },
    [router],
  );

  const run = useCallback((action: PaletteAction) => {
    setOpen(false);
    action.onSelect();
  }, []);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      className="tp-palette-dialog"
      overlayClassName="tp-palette-overlay"
      contentClassName="tp-palette-content"
    >
      <Command className="tp-palette-command" loop>
        <CommandInput className="tp-palette-input" placeholder={placeholder} autoFocus />
        <CommandList className="tp-palette-list">
          <CommandEmpty className="tp-palette-empty">No matches.</CommandEmpty>

          <CommandGroup className="tp-palette-group" heading="Navigate">
            {navigate.map((entry) => (
              <CommandItem
                key={entry.id}
                className="tp-palette-item"
                value={entry.label}
                keywords={entry.keywords}
                onSelect={() => go(entry)}
              >
                {entry.label}
              </CommandItem>
            ))}
          </CommandGroup>

          {quick.length > 0 ? (
            <CommandGroup className="tp-palette-group" heading="Quick actions">
              {quick.map((entry) => (
                <CommandItem
                  key={entry.id}
                  className="tp-palette-item"
                  value={entry.label}
                  keywords={entry.keywords}
                  onSelect={() => go(entry)}
                >
                  {entry.label}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {actions.length > 0 ? (
            <CommandGroup className="tp-palette-group" heading="Account">
              {actions.map((action) => (
                <CommandItem
                  key={action.id}
                  className="tp-palette-item"
                  value={action.label}
                  keywords={action.keywords}
                  onSelect={() => run(action)}
                >
                  {action.label}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
