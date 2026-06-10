# LeadWolf Planning — Consistency Checklist

> `plan-weaver` runs this after every change (step 6), and runs the **whole** list in audit-only mode.
> Each check has: what to verify, how, and the fix. Emit a final verdict: **pass | warn | fail**.
> `fail` = a broken reference or a contradiction; `warn` = something a human should decide.

## A. Link integrity
- [ ] Every relative markdown link in changed docs resolves to a real file under `docs/planning/`.
- [ ] Every `[NN §S](...)` anchor points at a heading that still exists (verify after renumbering).
- [ ] Bidirectional pairs from `doc-map.md §2` have links in **both** directions.
- **Fix:** repair the path/anchor, or add the missing reciprocal link.

## B. Heading numbering
- [ ] L2 sections in each touched doc are consecutively numbered (1,2,3,… no gaps/dupes).
- [ ] Inserting/removing a section renumbered the following ones, and updated `§` refs to them.
- **Fix:** renumber + update references.

## C. Decision-log ↔ ADR parity (the tripod)
- [ ] Every locked decision has a row in `00 §7` with a working "Why / ADR" link.
- [ ] Every ADR referenced in `00 §7` exists and has a `Status:` line.
- [ ] For each decision touched: lead doc, `00 §7` row, and the ADR all state the **same** choice.
- [ ] An ADR's "Context doc" list matches the docs that actually cite it (`doc-map.md §6`).
- **Fix:** reconcile the three; correct context-doc lists.

## D. Matrix ↔ roadmap parity (H10)
- [ ] Each module in the `05` feature→milestone matrix has the **same** milestone as its `10`
      milestone definition (current set: M0–M5 MVP + M7–M16 beyond; there is no M6).
- [ ] Each module in the matrix is actually described in `05 §1–§N`.
- **Fix:** align the matrix cell and the roadmap detail; add a missing module description.

## E. Risk ↔ milestone-DoD parity
- [ ] Each risk in the `10` register names an owner-milestone that exists.
- [ ] That milestone's Definition-of-Done includes the risk's mitigation.
- **Fix:** add the mitigation to the milestone DoD or correct the owner.

## F. Shared-vocabulary / enum drift
- [ ] For each term in `doc-map.md §5`, the value set in the **definition** matches every **usage**.
      (e.g. `email_status` values in 03 §5 == those referenced in 06 §7, 07 §11, 09 §3.)
- [ ] No doc uses a status/role/entry-type value that isn't in the definition.
- **Fix:** update the definition or the stray usage so they match; if a value was added, propagate it
      to every usage location.

## G. Hazard set completeness (H1–H10)
- [ ] If the change touched any hazard concept, **all** its locations (`doc-map.md §4`) were edited and
      now read consistently — especially H1 reveal transaction {07 §3, 08 §3, 09 §3} and
      H2 ledger invariant {03 §8, 07 §2, 07 §8, 10 M3}.
- **Fix:** edit the missed location(s).

## H. Open-questions hygiene
- [ ] A decision that resolved an open question marked it resolved (or removed it) in the owning doc
      and in `00 §8` if listed there.
- [ ] Newly-surfaced uncertainties were added as open questions in the right doc.
- **Fix:** update the open-questions section(s).

## I. Placeholders & no-fabrication
- [ ] No concrete price/number was hardcoded where 07 §1 says "placeholder".
- [ ] No invented facts; uncertain items are phrased as open questions, not asserted.
- **Fix:** replace with a reference to the placeholder / convert to an open question.

## J. README index
- [ ] If a doc was added/renamed/removed, the `README.md` index table reflects it.
- **Fix:** update the index row.

## K. doc-map currency
- [ ] If the change added/removed a doc, link, hazard, or vocab term, `doc-map.md` was updated to match.
- **Fix:** update `reference/doc-map.md`.

---

### Report shape
```
consistency: pass | warn | fail
checks:
  A link-integrity: pass
  C decision-tripod: pass
  D matrix↔roadmap: warn — 05 matrix shows Export@M3 but 10 lists it under M3 DoD only as CSV; confirm
  F vocab-drift:    fail — 09 §3 references email_status 'verified' not in 03 §5 enum
findings:
  - {check: F, location: "09 §3", issue: "...", fix: "use 'valid'"}
```
