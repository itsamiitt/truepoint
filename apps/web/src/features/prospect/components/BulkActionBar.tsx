// BulkActionBar.tsx — the sticky bulk-action bar shown when one or more prospect rows are selected (04 §5,
// 11 §4.2, 24). It carries the monetized reveal path (BulkRevealDialog) plus the full Phase-3 bulk surface
// wired to the backend's bulkActionsApi: add-to-list (existing or a new list), add-to-sequence, assign/clear
// owner, add/remove tags, change status, enrich/re-verify, export CSV, and archive. Every mutation runs behind
// a small confirm dialog (the picker dialogs double as the confirm) and reports the SERVER-returned affected
// count via a toast. The bar also offers "select all N matching" (searchCount) so a mutation can target the
// whole result set via { criteria } instead of the explicit ids. View composition + dispatch only — the spend,
// owner-policy, visible-id filtering, affected counts, and audit all live server-side.
"use client";

import type {
  BulkSelection,
  BulkSpendEstimate,
  ContactQuery,
  MaskedContact,
  OutreachStatus,
  Tag,
} from "@leadwolf/types";
import {
  Dialog,
  DropdownMenu,
  FieldGroup,
  type MenuItem,
  TpButton,
  TpCheckbox,
  TpInput,
  TpSelect,
  useToast,
} from "@leadwolf/ui";
import {
  Archive,
  Download,
  ListPlus,
  MoreHorizontal,
  RefreshCw,
  Send,
  Tag as TagIcon,
  UserCog,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError } from "../api";
import {
  bulkAddTags,
  bulkAddToList,
  bulkArchive,
  bulkAssignOwner,
  bulkChangeStatus,
  bulkEnrich,
  bulkEnroll,
  bulkEstimate,
  bulkExportCsv,
  bulkRemoveTags,
  searchCount,
} from "../bulkActionsApi";
import {
  type SequenceOption,
  createList,
  currentUserId,
  fetchLists,
  fetchSequenceOptions,
} from "../bulkResourcesApi";
import type { ProspectBulkSelection } from "../hooks/useBulkSelection";
import { useCreditBalance } from "../hooks/useCreditBalance";
import styles from "../prospect.module.css";
import { OUTREACH_STATUS_OPTIONS } from "../types";
import { BulkRevealDialog } from "./BulkRevealDialog";
import { BulkRevealJobDialog } from "./BulkRevealJobDialog";

/** The resolved server selection (never null inside `run`, which guards it). */
type BulkSelectionResolved = BulkSelection;

/** Which secondary dialog (picker) is open, if any. */
type ActiveDialog =
  | null
  | "list"
  | "sequence"
  | "owner"
  | "addTags"
  | "removeTags"
  | "status"
  | "enrich"
  | "archive"
  | "export";

/** The bulk actions a single row (RowActions) can request the bar to open with that row pre-selected. */
export type RowBulkAction = "list" | "addTags" | "status";

export function BulkActionBar({
  selection,
  query,
  selectedContacts,
  revealableIds,
  tags,
  requestedAction,
  onRequestHandled,
  onRevealed,
  onMutated,
  hideSelectAllMatching,
  extraActions,
}: {
  /** The selection model (explicit ids OR "all N matching"); drives the targeted BulkSelection. */
  selection: ProspectBulkSelection;
  /** The page's active search query — the `criteria` for select-all-matching + searchCount. */
  query: ContactQuery;
  /** The full selected masked rows (drives the reveal targets in explicit-id mode). */
  selectedContacts: MaskedContact[];
  /** Selected ids that can actually be revealed (hasEmail && !isRevealed) — explicit-id mode only. */
  revealableIds: string[];
  /** The workspace tags (for the add/remove-tags pickers). */
  tags: Tag[];
  /** A row-level action to open with the (already seeded) single-row selection; null = none pending. */
  requestedAction?: RowBulkAction | null;
  /** Fired once a requestedAction has been opened, so the parent can reset it. */
  onRequestHandled?: () => void;
  /** Fired with the ids that were revealed so the parent can flip rows + clear the selection. */
  onRevealed: (revealedIds: string[]) => void;
  /** Fired after any non-reveal mutation so the parent can reload the grid + clear the selection. */
  onMutated?: () => void;
  /**
   * Hide the "Select all N matching" escalation. Surfaces that aren't backed by the workspace search query
   * (e.g. a list's members — where `query` is not the membership criteria) pass this so the bar never offers
   * an escalation that would wrongly resolve to the whole workspace instead of the current set.
   */
  hideSelectAllMatching?: boolean;
  /** Extra surface-specific actions rendered in the bar (e.g. a list's "Remove from list"). Explicit-ids only. */
  extraActions?: ReactNode;
}) {
  const toast = useToast();
  const { balance } = useCreditBalance();
  const [revealing, setRevealing] = useState(false);
  const [revealingAll, setRevealingAll] = useState(false); // the async job path (select-all-matching)
  const [dialog, setDialog] = useState<ActiveDialog>(null);
  const [busy, setBusy] = useState(false);

  // Lazily-loaded option lists for the pickers (fetched on first open of the relevant dialog).
  const [lists, setLists] = useState<{ id: string; name: string }[] | null>(null);
  const [sequences, setSequences] = useState<SequenceOption[] | null>(null);
  // The pre-flight ESTIMATE shown in the enrich/re-verify confirm (list-plan D5 — no surprise spend). Fetched
  // server-side when that dialog opens; null while loading / on failure (the confirm still works without it).
  const [enrichEstimate, setEnrichEstimate] = useState<BulkSpendEstimate | null>(null);

  const { count, allMatching, toBulkSelection, clear, selectAllMatching } = selection;
  const revealable = revealableIds.length;
  const me = currentUserId();

  /** The server selection for the current mode, or null when nothing is selected. */
  const sel = useCallback(() => toBulkSelection(query), [toBulkSelection, query]);

  // Fetch the enrich estimate whenever the enrich/re-verify dialog opens (D5 estimate-before-run). Re-verify
  // /enrich fills the overlay as a SYSTEM cost, so the projected charge is 0 — the estimate confirms that and
  // shows how many members will be (freshly) re-verified, so the user confirms a known-free action.
  useEffect(() => {
    if (dialog !== "enrich") {
      setEnrichEstimate(null);
      return;
    }
    const selection = sel();
    if (!selection) return;
    let live = true;
    setEnrichEstimate(null);
    bulkEstimate(selection, "enrich")
      .then((e) => {
        if (live) setEnrichEstimate(e);
      })
      .catch(() => {
        if (live) setEnrichEstimate(null);
      });
    return () => {
      live = false;
    };
  }, [dialog, sel]);

  /** Run a bulk mutation: resolve the selection, await it, toast the affected count, then reload + clear. */
  const run = useCallback(
    async (
      label: string,
      fn: (selection: NonNullable<BulkSelectionResolved>) => Promise<number>,
    ) => {
      const selection = sel();
      if (!selection) return;
      setBusy(true);
      try {
        const affected = await fn(selection);
        toast.success(
          `${label} — ${affected.toLocaleString()} contact${affected === 1 ? "" : "s"}`,
        );
        setDialog(null);
        onMutated?.();
        clear();
      } catch (e) {
        const msg =
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : "Something went wrong";
        toast.error(`Could not ${label.toLowerCase()}`, msg);
      } finally {
        setBusy(false);
      }
    },
    [sel, onMutated, clear, toast],
  );

  /** Escalate to "select all N matching" via searchCount, so a mutation can target the whole result set. */
  const onSelectAllMatching = useCallback(async () => {
    try {
      const { total } = await searchCount(query);
      selectAllMatching(total);
    } catch (e) {
      toast.error("Could not count results", e instanceof Error ? e.message : undefined);
    }
  }, [query, selectAllMatching, toast]);

  const loadLists = useCallback(async () => {
    try {
      setLists((await fetchLists()).map((l) => ({ id: l.id, name: l.name })));
    } catch {
      setLists([]);
    }
  }, []);

  const openListDialog = async () => {
    setDialog("list");
    if (lists === null) await loadLists();
  };

  // Open the dialog a row-level action requested (the page seeds the single-row selection first), then ack.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire only when the parent sets a new request.
  useEffect(() => {
    if (!requestedAction) return;
    setDialog(requestedAction);
    if (requestedAction === "list" && lists === null) void loadLists();
    onRequestHandled?.();
  }, [requestedAction]);

  const openSequenceDialog = async () => {
    setDialog("sequence");
    if (sequences === null) {
      try {
        setSequences(await fetchSequenceOptions());
      } catch {
        setSequences([]);
      }
    }
  };

  /** Trigger a browser download from the export Blob. */
  const downloadCsv = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const moreItems: MenuItem[] = [
    {
      label: "Add to list",
      icon: <ListPlus size={15} />,
      onSelect: () => void openListDialog(),
    },
    {
      label: "Add to sequence",
      icon: <Send size={15} />,
      onSelect: () => void openSequenceDialog(),
    },
    {
      label: "Assign owner",
      icon: <UserCog size={15} />,
      onSelect: () => setDialog("owner"),
      separatorBefore: true,
    },
    { label: "Add tags", icon: <TagIcon size={15} />, onSelect: () => setDialog("addTags") },
    { label: "Remove tags", icon: <TagIcon size={15} />, onSelect: () => setDialog("removeTags") },
    { label: "Change status", icon: <RefreshCw size={15} />, onSelect: () => setDialog("status") },
    {
      label: "Re-verify / enrich",
      icon: <RefreshCw size={15} />,
      onSelect: () => setDialog("enrich"),
      separatorBefore: true,
    },
    { label: "Export CSV", icon: <Download size={15} />, onSelect: () => setDialog("export") },
    {
      label: "Archive",
      icon: <Archive size={15} />,
      onSelect: () => setDialog("archive"),
      danger: true,
      separatorBefore: true,
    },
  ];

  return (
    <>
      <section className={styles.bulkBar} aria-label="Bulk actions">
        <span className={styles.bulkCount}>
          {count.toLocaleString()} selected{allMatching ? " (all matching)" : ""}
        </span>
        {!allMatching && !hideSelectAllMatching ? (
          <button
            type="button"
            className={styles.bulkLink}
            onClick={() => void onSelectAllMatching()}
          >
            Select all matching
          </button>
        ) : null}
        <span className={styles.bulkBalance}>
          Balance <strong>{balance === null ? "—" : balance.toLocaleString()}</strong>
        </span>
        <span className={styles.bulkSep} aria-hidden />
        <div className={styles.bulkActions}>
          <TpButton
            variant="primary"
            size="sm"
            onClick={() => (allMatching ? setRevealingAll(true) : setRevealing(true))}
            disabled={!allMatching && revealable === 0}
            title={
              allMatching
                ? "Reveal every matching contact (runs in the background)"
                : revealable === 0
                  ? "No selected contacts need a reveal"
                  : undefined
            }
          >
            Reveal {allMatching ? "all" : revealable}
          </TpButton>
          <TpButton
            variant="ghost"
            size="sm"
            leftIcon={<ListPlus size={15} />}
            onClick={() => void openListDialog()}
          >
            Add to list
          </TpButton>
          <TpButton
            variant="ghost"
            size="sm"
            leftIcon={<Send size={15} />}
            onClick={() => void openSequenceDialog()}
          >
            Enroll
          </TpButton>
          <DropdownMenu
            trigger={({ toggle }) => (
              <TpButton variant="ghost" size="sm" onClick={toggle} aria-label="More bulk actions">
                <MoreHorizontal size={15} />
              </TpButton>
            )}
            side="top"
            items={moreItems}
          />
          {extraActions}
          <TpButton variant="link" size="sm" onClick={clear}>
            Clear
          </TpButton>
        </div>
      </section>

      <BulkRevealDialog
        contactIds={revealableIds}
        balance={balance}
        open={revealing}
        onClose={() => setRevealing(false)}
        onRevealed={(ids) => {
          onRevealed(ids);
          setRevealing(false);
        }}
      />

      {/* Async job path — reveal EVERY matching contact (select-all). Degrades gracefully while the feature
          is dark (confirm 403 → "rolling out"). */}
      <BulkRevealJobDialog
        open={revealingAll}
        onClose={() => setRevealingAll(false)}
        criteria={query}
        onDone={() => {
          onMutated?.();
          clear();
          setRevealingAll(false);
        }}
      />

      {/* Add to list (existing or new) */}
      <ListPickerDialog
        open={dialog === "list"}
        lists={lists}
        busy={busy}
        count={count}
        explicitIds={allMatching ? null : selectedContacts.map((c) => c.id)}
        onClose={() => setDialog(null)}
        onConfirm={async (listId, contactIds) => {
          // Add-to-list uses the lists endpoint, which takes an explicit { contactIds } body (no `criteria`
          // branch), so select-all-matching is disabled for this op — the dialog guards it via explicitIds.
          setBusy(true);
          try {
            const { affected } = await bulkAddToList(listId, contactIds);
            toast.success(
              `Added to list — ${affected.toLocaleString()} contact${affected === 1 ? "" : "s"}`,
            );
            setDialog(null);
            onMutated?.();
            clear();
          } catch (e) {
            toast.error("Could not add to list", e instanceof Error ? e.message : undefined);
          } finally {
            setBusy(false);
          }
        }}
        onCreate={createList}
      />

      {/* Add to sequence */}
      <SequencePickerDialog
        open={dialog === "sequence"}
        sequences={sequences}
        busy={busy}
        count={count}
        onClose={() => setDialog(null)}
        onConfirm={(sequenceId) =>
          run("Enrolled into sequence", async (s) => (await bulkEnroll(sequenceId, s)).affected)
        }
      />

      {/* Assign / clear owner */}
      <ConfirmDialog
        open={dialog === "owner"}
        title="Assign owner"
        body={
          <p className={styles.dialogNote}>
            Set the owner for the {count.toLocaleString()} selected contact
            {count === 1 ? "" : "s"}. You can assign them to yourself or clear the owner; assigning
            to other teammates is available from each record.
          </p>
        }
        actions={
          <>
            <TpButton variant="secondary" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run("Cleared owner", async (s) => (await bulkAssignOwner(s, null)).affected)
              }
            >
              Clear owner
            </TpButton>
            {me ? (
              <TpButton
                disabled={busy}
                onClick={() =>
                  void run("Assigned to me", async (s) => (await bulkAssignOwner(s, me)).affected)
                }
              >
                Assign to me
              </TpButton>
            ) : null}
          </>
        }
        onClose={() => setDialog(null)}
      />

      {/* Add tags */}
      <TagPickerDialog
        open={dialog === "addTags"}
        verb="Add tags"
        tags={tags}
        busy={busy}
        count={count}
        onClose={() => setDialog(null)}
        onConfirm={(tagIds) =>
          run("Added tags", async (s) => (await bulkAddTags(s, tagIds)).affected)
        }
      />

      {/* Remove tags */}
      <TagPickerDialog
        open={dialog === "removeTags"}
        verb="Remove tags"
        tags={tags}
        busy={busy}
        count={count}
        onClose={() => setDialog(null)}
        onConfirm={(tagIds) =>
          run("Removed tags", async (s) => (await bulkRemoveTags(s, tagIds)).affected)
        }
      />

      {/* Change status */}
      <StatusPickerDialog
        open={dialog === "status"}
        busy={busy}
        count={count}
        onClose={() => setDialog(null)}
        onConfirm={(status) =>
          run("Changed status", async (s) => (await bulkChangeStatus(s, status)).affected)
        }
      />

      {/* Re-verify / enrich — with the D5 pre-flight estimate (re-verify/enrich is a system cost: 0 credits). */}
      <ConfirmDialog
        open={dialog === "enrich"}
        title="Re-verify / enrich"
        body={
          <>
            <p className={styles.dialogNote}>
              Queue a re-verify/enrichment job for the {count.toLocaleString()} selected contact
              {count === 1 ? "" : "s"}. The job runs in the background; nothing is charged at
              enqueue.
            </p>
            <p className={styles.revealMeta}>
              {enrichEstimate ? (
                <>
                  Projected cost{" "}
                  <strong>
                    {enrichEstimate.projectedMaxCredits.toLocaleString()} credit
                    {enrichEstimate.projectedMaxCredits === 1 ? "" : "s"}
                  </strong>{" "}
                  — re-verifying owned data is free; you only pay later, per valid reveal. Balance{" "}
                  <strong>
                    {enrichEstimate.balance === null
                      ? "—"
                      : enrichEstimate.balance.toLocaleString()}
                  </strong>{" "}
                  is unaffected.
                </>
              ) : (
                "Estimating cost…"
              )}
            </p>
          </>
        }
        actions={
          <>
            <TpButton variant="secondary" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton
              disabled={busy}
              onClick={() =>
                void run("Queued enrichment", async (s) => (await bulkEnrich(s)).affected)
              }
            >
              Queue job
            </TpButton>
          </>
        }
        onClose={() => setDialog(null)}
      />

      {/* Export CSV */}
      <ConfirmDialog
        open={dialog === "export"}
        title="Export CSV"
        body={
          <p className={styles.dialogNote}>
            Export the {count.toLocaleString()} selected contact{count === 1 ? "" : "s"} as a CSV of
            the masked (non-PII) columns. Revealed PII is never included in the export.
          </p>
        }
        actions={
          <>
            <TpButton variant="secondary" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton
              disabled={busy}
              onClick={async () => {
                const selection = sel();
                if (!selection) return;
                setBusy(true);
                try {
                  const { blob, affected, filename } = await bulkExportCsv(selection);
                  downloadCsv(blob, filename);
                  toast.success(
                    `Exported ${affected.toLocaleString()} row${affected === 1 ? "" : "s"}`,
                  );
                  setDialog(null);
                } catch (e) {
                  const msg =
                    e instanceof ApiError ? e.message : e instanceof Error ? e.message : undefined;
                  toast.error("Could not export", msg);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Export
            </TpButton>
          </>
        }
        onClose={() => setDialog(null)}
      />

      {/* Archive (soft hide) */}
      <ConfirmDialog
        open={dialog === "archive"}
        title="Archive contacts"
        body={
          <p className={styles.dialogNote}>
            Archive the {count.toLocaleString()} selected contact{count === 1 ? "" : "s"}. Archived
            contacts stop appearing in search and lists; this can be undone later.
          </p>
        }
        actions={
          <>
            <TpButton variant="secondary" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton
              variant="danger"
              disabled={busy}
              onClick={() => void run("Archived", async (s) => (await bulkArchive(s)).affected)}
            >
              Archive
            </TpButton>
          </>
        }
        onClose={() => setDialog(null)}
      />
    </>
  );
}

// ── Generic confirm dialog ─────────────────────────────────────────────────────────────────────────────
function ConfirmDialog({
  open,
  title,
  body,
  actions,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  actions: ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} footer={actions}>
      {body}
    </Dialog>
  );
}

// ── Add-to-list picker (existing list or a new one) ───────────────────────────────────────────────────
function ListPickerDialog({
  open,
  lists,
  busy,
  count,
  explicitIds,
  onClose,
  onConfirm,
  onCreate,
}: {
  open: boolean;
  lists: { id: string; name: string }[] | null;
  busy: boolean;
  count: number;
  /** The explicit contact ids to add; null = select-all-matching (unsupported by the lists endpoint). */
  explicitIds: string[] | null;
  onClose: () => void;
  onConfirm: (listId: string, contactIds: string[]) => void;
  onCreate: (name: string) => Promise<{ id: string }>;
}) {
  const [listId, setListId] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  const submit = async () => {
    if (!explicitIds) return;
    let targetId = listId;
    if (!targetId && newName.trim()) {
      setCreating(true);
      try {
        targetId = (await onCreate(newName.trim())).id;
      } catch (e) {
        toast.error("Could not create list", e instanceof Error ? e.message : undefined);
        setCreating(false);
        return;
      }
      setCreating(false);
    }
    if (!targetId) return;
    onConfirm(targetId, explicitIds);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add to list"
      description={`Add the ${count.toLocaleString()} selected contact${count === 1 ? "" : "s"} to a list.`}
      footer={
        <>
          <TpButton variant="secondary" onClick={onClose} disabled={busy || creating}>
            Cancel
          </TpButton>
          <TpButton
            onClick={() => void submit()}
            disabled={busy || creating || !explicitIds || (!listId && newName.trim() === "")}
          >
            {creating ? "Creating…" : "Add"}
          </TpButton>
        </>
      }
    >
      {!explicitIds ? (
        <p className={styles.dialogNote}>
          Adding to a list needs an explicit selection. Clear “all matching” and pick specific rows
          first.
        </p>
      ) : (
        <div className={styles.dialogStack}>
          <FieldGroup label="Existing list" htmlFor="tp-bulk-list-existing">
            <TpSelect
              id="tp-bulk-list-existing"
              value={listId}
              onChange={(e) => {
                setListId(e.target.value);
                if (e.target.value) setNewName("");
              }}
              disabled={lists === null}
            >
              <option value="">{lists === null ? "Loading…" : "Choose a list…"}</option>
              {(lists ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </TpSelect>
          </FieldGroup>
          <div className={styles.dialogOr}>or create a new list</div>
          <FieldGroup label="New list name" htmlFor="tp-bulk-list-new">
            <TpInput
              id="tp-bulk-list-new"
              value={newName}
              maxLength={120}
              placeholder="e.g. Q3 priority outreach"
              onChange={(e) => {
                setNewName(e.target.value);
                if (e.target.value) setListId("");
              }}
            />
          </FieldGroup>
        </div>
      )}
    </Dialog>
  );
}

// ── Add-to-sequence picker ─────────────────────────────────────────────────────────────────────────────
function SequencePickerDialog({
  open,
  sequences,
  busy,
  count,
  onClose,
  onConfirm,
}: {
  open: boolean;
  sequences: SequenceOption[] | null;
  busy: boolean;
  count: number;
  onClose: () => void;
  onConfirm: (sequenceId: string) => void;
}) {
  const [sequenceId, setSequenceId] = useState("");
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add to sequence"
      description={`Enroll the ${count.toLocaleString()} selected contact${count === 1 ? "" : "s"} into a sequence. Already-enrolled or suppressed contacts are skipped.`}
      footer={
        <>
          <TpButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </TpButton>
          <TpButton
            onClick={() => sequenceId && onConfirm(sequenceId)}
            disabled={busy || !sequenceId}
          >
            Enroll
          </TpButton>
        </>
      }
    >
      <FieldGroup label="Sequence" htmlFor="tp-bulk-sequence">
        <TpSelect
          id="tp-bulk-sequence"
          value={sequenceId}
          onChange={(e) => setSequenceId(e.target.value)}
          disabled={sequences === null}
        >
          <option value="">{sequences === null ? "Loading…" : "Choose a sequence…"}</option>
          {(sequences ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </TpSelect>
      </FieldGroup>
    </Dialog>
  );
}

// ── Tag add/remove picker ──────────────────────────────────────────────────────────────────────────────
function TagPickerDialog({
  open,
  verb,
  tags,
  busy,
  count,
  onClose,
  onConfirm,
}: {
  open: boolean;
  verb: string;
  tags: Tag[];
  busy: boolean;
  count: number;
  onClose: () => void;
  onConfirm: (tagIds: string[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={verb}
      description={`${verb} for the ${count.toLocaleString()} selected contact${count === 1 ? "" : "s"}.`}
      footer={
        <>
          <TpButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </TpButton>
          <TpButton
            onClick={() => picked.size > 0 && onConfirm([...picked])}
            disabled={busy || picked.size === 0}
          >
            {verb}
          </TpButton>
        </>
      }
    >
      {tags.length === 0 ? (
        <p className={styles.dialogNote}>
          No tags yet. Create tags from a record’s Tags section first.
        </p>
      ) : (
        <div className={styles.dialogStack}>
          {tags.map((t) => (
            <TpCheckbox
              key={t.id}
              className={styles.dialogCheckRow}
              label={t.name}
              checked={picked.has(t.id)}
              onChange={() => toggle(t.id)}
            />
          ))}
        </div>
      )}
    </Dialog>
  );
}

// ── Change-status picker ───────────────────────────────────────────────────────────────────────────────
function StatusPickerDialog({
  open,
  busy,
  count,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  count: number;
  onClose: () => void;
  onConfirm: (status: OutreachStatus) => void;
}) {
  const [status, setStatus] = useState<OutreachStatus | "">("");
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change status"
      description={`Set the outreach status for the ${count.toLocaleString()} selected contact${count === 1 ? "" : "s"}.`}
      footer={
        <>
          <TpButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </TpButton>
          <TpButton onClick={() => status && onConfirm(status)} disabled={busy || status === ""}>
            Apply
          </TpButton>
        </>
      }
    >
      <FieldGroup label="Outreach status" htmlFor="tp-bulk-status">
        <TpSelect
          id="tp-bulk-status"
          value={status}
          onChange={(e) => setStatus(e.target.value as OutreachStatus)}
        >
          <option value="">Choose a status…</option>
          {OUTREACH_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </TpSelect>
      </FieldGroup>
    </Dialog>
  );
}
