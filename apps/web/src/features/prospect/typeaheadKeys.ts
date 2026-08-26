// typeaheadKeys.ts — the keyboard model of a typeahead listbox (WCAG 2.2 AA; the design accessibility rule
// that every interactive element is keyboard-reachable — the old picker was mouse-only). Pure: the picker
// feeds it a key name and gets back the next state plus whether to select, so ↑ ↓ Home End Enter Esc are a
// unit test rather than a manual pass.

export interface TypeaheadKeyState {
  open: boolean;
  /** -1 = nothing highlighted. */
  activeIndex: number;
}

export interface TypeaheadKeyResult extends TypeaheadKeyState {
  /** Enter on a highlighted option: the caller adds `options[activeIndex]`. */
  select: boolean;
  /** False when the key is not ours (the caller must NOT preventDefault — typing continues). */
  handled: boolean;
}

export function typeaheadKey(
  state: TypeaheadKeyState,
  key: string,
  count: number,
): TypeaheadKeyResult {
  const unchanged = { ...state, select: false, handled: false };
  switch (key) {
    case "ArrowDown":
      return {
        open: true,
        activeIndex: count === 0 ? -1 : (state.activeIndex + 1) % count,
        select: false,
        handled: true,
      };
    case "ArrowUp":
      return {
        open: true,
        activeIndex:
          count === 0
            ? -1
            : state.activeIndex < 0
              ? count - 1
              : (state.activeIndex - 1 + count) % count,
        select: false,
        handled: true,
      };
    case "Home":
      return { open: true, activeIndex: count === 0 ? -1 : 0, select: false, handled: true };
    case "End":
      return { open: true, activeIndex: count - 1, select: false, handled: true };
    case "Enter":
      if (state.open && state.activeIndex >= 0 && state.activeIndex < count) {
        return { open: false, activeIndex: -1, select: true, handled: true };
      }
      return unchanged;
    case "Escape":
      // Only swallow Escape while the list is open — otherwise it belongs to the drawer/dialog above.
      return { open: false, activeIndex: -1, select: false, handled: state.open };
    default:
      return unchanged;
  }
}

/** The DOM id of one option, for aria-activedescendant. */
export function optionId(listId: string, index: number): string {
  return `${listId}-opt-${index}`;
}
