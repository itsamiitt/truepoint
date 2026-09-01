// dom.ts — tiny element factories for the card's vanilla-DOM renderers. User data goes in via textContent
// only, never innerHTML (03 §1.10): everything rendered here sits inside a page we do not own.
export function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(
  className: string,
  label: string,
  onClick: () => void,
  opts?: { disabled?: boolean; ariaLabel?: string },
): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  if (opts?.disabled) node.disabled = true;
  if (opts?.ariaLabel) node.setAttribute("aria-label", opts.ariaLabel);
  node.addEventListener("click", onClick);
  return node;
}

/** A status badge: tone class + text. The text carries the meaning; the tone never stands alone. */
export function badge(tone: "success" | "warning" | "muted", text: string): HTMLElement {
  return el("span", `badge ${tone}`, text);
}

/** The card's fixed regions. The renderers repaint header text + body + footer wholesale on every VM. */
export interface CardRegions {
  avatarEl: HTMLElement;
  nameEl: HTMLElement;
  subEl: HTMLElement;
  metaEl: HTMLElement;
  pillEl: HTMLElement;
  bodyEl: HTMLElement;
  footerEl: HTMLElement;
}

/** What a click means is the ORCHESTRATOR's business; the renderers only wire ids to these callbacks. */
export interface CardHandlers {
  onAction(id: string): void;
  onCopy(channel: "email" | "phone", value: string): void;
  onOpenPanel(): void;
}
