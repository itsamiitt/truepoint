// styles.ts — the card's own stylesheet, concatenated after the re-scoped DS tokens (shadowTokens.ts).
// Token-driven with inline fallbacks: a content script runs in a page that never loaded tokens.css, so the
// fallback after each var() is what keeps the card styled if the token import ever breaks — and the fallbacks
// are the DS's own light values, which is why lint:design-tokens sanctions the pattern.
export const baseCss = `
:host { all: initial; }
.card {
  position: fixed; top: 84px; inset-inline-end: 24px; width: 340px;
  max-height: min(560px, calc(100vh - 108px));
  display: flex; flex-direction: column;
  /* An explicit stack, NOT var(--font-sans): that token resolves through --font-geist-sans, which next/font
     defines on the app's documents and never on a LinkedIn page — the substitution fails and font-family
     falls all the way back to the initial value (a serif, under all:initial). No @font-face reaches a
     content script either, so the system stack is the honest choice here. */
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--tp-ink, #111827);
  background: var(--tp-surface, #fff); border: 1px solid var(--tp-hairline-2, #e5e7eb);
  border-radius: var(--tp-radius-card, 14px);
  /* Fallback matches the DS token it stands in for — it used to be a single heavier, colder shadow, so on
     the one surface where the fallback actually fired the card did not look like a TruePoint popover. */
  box-shadow: var(--tp-shadow-popover, 0 4px 16px rgba(17,24,39,.08), 0 1px 3px rgba(17,24,39,.06));
  padding: var(--tp-space-4, 16px); z-index: 2147483647;
}
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; flex: none; }
.idrow { display: flex; gap: 10px; align-items: center; min-width: 0; }
.avatar {
  width: 40px; height: 40px; border-radius: 50%; flex: none; overflow: hidden;
  background: var(--tp-surface-3, #f4f5f7); color: var(--tp-ink-2, #374151);
  display: grid; place-items: center; font-size: 14px; font-weight: 600;
}
.avatar.square { border-radius: 9px; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.identity { min-width: 0; }
.name { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.close {
  border: 0; background: transparent; padding: 0; margin: -2px -2px 0 0; cursor: pointer;
  font: inherit; font-size: 13px; line-height: 1; color: var(--tp-ink-3, #6b7280);
}
.close:hover { color: var(--tp-ink, #111827); }
.sub, .meta { font-size: 12px; color: var(--tp-ink-3, #6b7280); margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; flex: none;
  font-size: 13px; color: var(--tp-ink-2, #374151); }
.pill { font-size: 11px; border-radius: var(--tp-radius-sm, 6px); padding: 2px 8px;
  border: 1px solid var(--tp-hairline-2, #e5e7eb); color: var(--tp-ink-3, #6b7280); }
.divider { height: 1px; background: var(--tp-hairline, #f0f0f0); margin: 12px 0 0; flex: none; }
.body { overflow-y: auto; min-height: 0; }
.chrow { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; min-width: 0; }
.chval { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1;
  color: var(--tp-ink, #111827); }
.chval.masked { color: var(--tp-ink-3, #6b7280); letter-spacing: 0.04em; }
.chval.num { font-variant-numeric: tabular-nums; }
.badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; flex: none;
  border-radius: var(--tp-radius-sm, 6px); font-size: 10px; font-weight: 600; white-space: nowrap; }
.badge.success { color: var(--success-700, #15803d); background: var(--success-50, #eaf6ee); }
.badge.warning { color: var(--warning-700, #b45309); background: var(--warning-50, #fdf3e7); }
.badge.muted { color: var(--tp-ink-3, #6b7280); background: var(--tp-surface-3, #f4f5f7); }
.copybtn {
  border: 1px solid var(--tp-hairline-2, #e5e7eb); background: var(--tp-surface, #fff);
  color: var(--tp-ink, #111827); border-radius: var(--tp-radius-sm, 6px); padding: 2px 8px; flex: none;
  font-family: inherit; font-size: 11px; font-weight: 600; cursor: pointer;
}
.fresh { font-size: 11px; color: var(--tp-ink-3, #6b7280); margin-top: 5px; }
.hint { font-size: 12px; color: var(--tp-ink-3, #6b7280); margin-top: 8px; line-height: 1.45; }
.err { font-size: 12px; color: var(--danger-700, #b91c1c); margin-top: 8px; }
.hcount { font-size: 20px; font-weight: 650; letter-spacing: -0.02em; margin-top: 10px;
  font-variant-numeric: tabular-nums; }
.hcount .growth { font-size: 12px; font-weight: 500; color: var(--tp-ink-2, #374151); margin-inline-start: 6px; }
.skel { height: 12px; border-radius: 6px; background: var(--tp-surface-3, #f4f5f7); margin-top: 12px;
  animation: tp-pulse 1.2s ease-in-out infinite; }
@keyframes tp-pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .skel { animation: none; } }
.footer { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; flex: none; }
.btnrow { display: flex; gap: 8px; }
.btn { flex: 1; border: 0; border-radius: var(--radius, 8px); padding: 8px 12px; cursor: pointer;
  font-size: 13px; font-weight: 600; color: var(--tp-on-fill, #fff); background: var(--tp-btn, #111827);
  font-family: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.btn.secondary { color: var(--tp-ink, #111827); background: var(--tp-surface, #fff);
  border: 1px solid var(--tp-hairline-2, #e5e7eb); }
.btn[disabled] { opacity: .6; cursor: default; }
.ghost { width: 100%; background: transparent; border: 0; padding: 5px; cursor: pointer;
  font-family: inherit; font-size: 12px; font-weight: 600; color: var(--tp-ink-2, #374151); }
.ghost:hover { color: var(--tp-ink, #111827); }
`;
