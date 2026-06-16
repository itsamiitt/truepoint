// CommandPalette.tsx — the global Cmd/Ctrl-K command palette (11 §3). Mounted once by the shell; a cmdk
// dialog over a static client registry (navigate to the 6 destinations + a few quick actions). It owns no
// data: workspace-switching is decoupled via the "command:switch-workspace" window event (the switcher in
// the rail listens), and sign-out calls authClient.logout(). Accessible + monochrome — cmdk gives us the
// listbox/role semantics and arrow-key nav; we only style it via the co-located module.css.
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

interface PaletteAction {
  id: string;
  label: string;
  /** Extra terms cmdk matches against so "billing" finds "Top up credits", etc. */
  keywords?: string[];
  run: (router: ReturnType<typeof useRouter>) => void;
}

/** Build a navigate action from a destination path so the registry stays a tidy table, not a wall of arrows. */
function navTo(id: string, label: string, href: string, keywords?: string[]): PaletteAction {
  return { id, label, keywords, run: (r) => r.push(href) };
}

const NAVIGATE: PaletteAction[] = [
  navTo("nav-home", "Home", "/home", ["dashboard"]),
  navTo("nav-prospect", "Prospect", "/prospect", ["search", "leads"]),
  navTo("nav-sequences", "Sequences", "/sequences", ["outreach"]),
  navTo("nav-inbox", "Inbox", "/inbox", ["replies"]),
  navTo("nav-reports", "Reports", "/reports", ["analytics"]),
  navTo("nav-settings", "Settings", "/settings/billing", ["preferences"]),
];

const QUICK: PaletteAction[] = [
  navTo("act-search", "New search", "/prospect", ["prospect", "find"]),
  navTo("act-import", "Import contacts", "/import", ["csv", "upload"]),
  navTo("act-topup", "Top up credits", "/settings/billing", ["billing", "buy", "balance"]),
];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Global toggle: Cmd/Ctrl-K opens (or toggles) the palette from anywhere in the signed-in shell.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Run an action then always close — keeps the palette modal and disposable.
  const runAction = useCallback(
    (action: PaletteAction) => {
      setOpen(false);
      action.run(router);
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
            {NAVIGATE.map((action) => (
              <CommandItem
                key={action.id}
                className={styles.item}
                value={action.label}
                keywords={action.keywords}
                onSelect={() => runAction(action)}
              >
                {action.label}
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandGroup className={styles.group} heading="Quick actions">
            {QUICK.map((action) => (
              <CommandItem
                key={action.id}
                className={styles.item}
                value={action.label}
                keywords={action.keywords}
                onSelect={() => runAction(action)}
              >
                {action.label}
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
