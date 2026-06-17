// CommandPalette.tsx — the global Cmd/Ctrl-K command palette (11 §3). Mounted once by the shell; a cmdk dialog
// over the central navConfig registry (navigate to the destinations + a few quick actions). It owns no data:
// workspace-switching is decoupled via the "command:switch-workspace" window event (the rail switcher listens),
// and sign-out calls authClient.logout(). It also opens on a "command:open" event (the top-bar global search).
"use client";

import { logout } from "@/lib/authClient";
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
import styles from "./CommandPalette.module.css";
import { PALETTE_NAVIGATE, PALETTE_QUICK, type PaletteEntry } from "./navConfig";

export function CommandPalette() {
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

  const switchWorkspace = useCallback(() => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("command:switch-workspace"));
  }, []);

  const signOut = useCallback(() => {
    setOpen(false);
    void logout();
  }, []);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      className={styles.dialog}
      overlayClassName={styles.overlay}
      contentClassName={styles.content}
    >
      <Command className={styles.command} loop>
        <CommandInput className={styles.input} placeholder="Type a command or search…" autoFocus />
        <CommandList className={styles.list}>
          <CommandEmpty className={styles.empty}>No matches.</CommandEmpty>

          <CommandGroup className={styles.group} heading="Navigate">
            {PALETTE_NAVIGATE.map((entry) => (
              <CommandItem
                key={entry.id}
                className={styles.item}
                value={entry.label}
                keywords={entry.keywords}
                onSelect={() => go(entry)}
              >
                {entry.label}
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandGroup className={styles.group} heading="Quick actions">
            {PALETTE_QUICK.map((entry) => (
              <CommandItem
                key={entry.id}
                className={styles.item}
                value={entry.label}
                keywords={entry.keywords}
                onSelect={() => go(entry)}
              >
                {entry.label}
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandGroup className={styles.group} heading="Account">
            <CommandItem
              className={styles.item}
              value="Switch workspace"
              keywords={["team", "tenant"]}
              onSelect={switchWorkspace}
            >
              Switch workspace
            </CommandItem>
            <CommandItem
              className={styles.item}
              value="Log out"
              keywords={["sign out", "logout"]}
              onSelect={signOut}
            >
              Log out
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
