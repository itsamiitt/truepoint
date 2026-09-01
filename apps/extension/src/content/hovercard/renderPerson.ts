// renderPerson.ts — paints a PersonCardVm into the card's regions. Diff-free full repaint of body + footer:
// the card is small enough that clearing and rebuilding is simpler and safer than tracking node identity.
// All user data lands via textContent (dom.ts factories) — never innerHTML.
import { t } from "../../i18n/index.ts";
import { type CardHandlers, type CardRegions, badge, button, el } from "./dom.ts";
import type { PersonCardVm } from "./viewModel.ts";

export function renderPerson(regions: CardRegions, vm: PersonCardVm, handlers: CardHandlers): void {
  regions.avatarEl.classList.remove("square");
  regions.avatarEl.textContent = vm.initials;
  regions.nameEl.textContent = vm.name;
  regions.subEl.textContent = vm.sub;
  regions.metaEl.textContent = vm.meta ?? "";
  regions.metaEl.hidden = !vm.meta;
  regions.pillEl.textContent = vm.pill;
  regions.pillEl.hidden = false;

  const body = regions.bodyEl;
  body.replaceChildren();

  if (vm.alert) {
    const row = el("div", "chrow");
    row.appendChild(badge("warning", vm.alert));
    body.appendChild(row);
  }

  if (vm.skeleton) {
    body.append(el("div", "skel"), el("div", "skel"));
  }

  for (const ch of vm.channels) {
    const row = el("div", "chrow");
    const valueClass = ["chval", ch.masked ? "masked" : null, ch.numeric ? "num" : null]
      .filter(Boolean)
      .join(" ");
    row.appendChild(el("span", valueClass, ch.line));
    if (ch.badge) row.appendChild(badge(ch.badge.tone, ch.badge.text));
    if (ch.isValue) {
      const value = ch.line;
      row.appendChild(
        button("copybtn", ch.copied ? t("contact.copied") : t("contact.copy"), () =>
          handlers.onCopy(ch.id, value),
        ),
      );
    }
    body.appendChild(row);
  }

  if (vm.freshnessLine) body.appendChild(el("div", "fresh", vm.freshnessLine));
  if (vm.hint) body.appendChild(el("div", "hint", vm.hint));
  if (vm.error) body.appendChild(el("div", "err", vm.error));

  const footer = regions.footerEl;
  footer.replaceChildren();
  if (vm.buttons.length > 0) {
    const rowEl = el("div", "btnrow");
    for (const b of vm.buttons) {
      rowEl.appendChild(
        button(
          b.kind === "secondary" ? "btn secondary" : "btn",
          b.label,
          () => handlers.onAction(b.id),
          { disabled: b.disabled },
        ),
      );
    }
    footer.appendChild(rowEl);
  }
  if (vm.openPanelLabel) {
    footer.appendChild(button("ghost", vm.openPanelLabel, () => handlers.onOpenPanel()));
  }
  footer.hidden = footer.childElementCount === 0;
}
