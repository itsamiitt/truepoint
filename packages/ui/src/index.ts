// Public surface of @leadwolf/ui — design tokens (./tokens.css), the primitives stylesheet (./primitives.css),
// the Tailwind theme (./theme.css), the cn() helper, and the presentational + shadcn-pattern primitives.
// React/styling only; no logic.
export { cn } from "./cn.ts";

// ── Dashboard surface primitives (token-driven, inline-styled) — used by apps/web. ─────────────────────
export { Card } from "./components/Card.tsx";
export { Spinner } from "./components/Spinner.tsx";
export { StatTile } from "./components/StatTile.tsx";
export { StatusBadge, type StatusTone } from "./components/StatusBadge.tsx";
export { Avatar } from "./components/Avatar.tsx";
export { Progress } from "./components/Progress.tsx";
export { Pagination } from "./components/Pagination.tsx";
export { Icon, type IconComponent } from "./components/Icon.tsx";

// ── State Kit — every async surface renders empty/loading/error through these for consistency. ─────────
export {
  Skeleton,
  LoadingState,
  EmptyState,
  ErrorState,
  StateSwitch,
} from "./components/state.tsx";

// ── Token form controls (Tp-prefixed; styling in primitives.css) — apps/web. ───────────────────────────
export {
  TpButton,
  type TpButtonProps,
  TpIconButton,
  type TpIconButtonProps,
  TpInput,
  type TpInputProps,
  TpTextarea,
  type TpTextareaProps,
  TpSelect,
  type TpSelectProps,
  TpCheckbox,
  type TpCheckboxProps,
  TpSwitch,
  type TpSwitchProps,
  TpChip,
  type TpChipProps,
} from "./components/controls.tsx";

// ── Form scaffolding. ──────────────────────────────────────────────────────────────────────────────────
export { FormSection, FieldGroup, FormRow } from "./components/form.tsx";

// ── Navigation / depth. ────────────────────────────────────────────────────────────────────────────────
export { Tabs, SegmentedControl, type TabItem } from "./components/Tabs.tsx";

// ── Overlays. ──────────────────────────────────────────────────────────────────────────────────────────
export { Dialog, Drawer } from "./components/overlay.tsx";
export {
  Popover,
  type PopoverProps,
  DropdownMenu,
  type MenuItem,
  Tooltip,
} from "./components/floating.tsx";

// ── Feedback. ──────────────────────────────────────────────────────────────────────────────────────────
export { ToastProvider, useToast, type ToastApi } from "./components/Toast.tsx";

// ── Data display. ──────────────────────────────────────────────────────────────────────────────────────
export { DataTable, type Column } from "./components/DataTable.tsx";
export { Combobox, type ComboOption } from "./components/Combobox.tsx";

// ── Tailwind/shadcn-pattern primitives — themed from the --tp-* tokens; no-JS friendly. Used by apps/auth. ──
export { Button, buttonVariants, type ButtonProps } from "./components/ui/button.tsx";
export { Input } from "./components/ui/input.tsx";
export { Label } from "./components/ui/label.tsx";
export { Alert } from "./components/ui/alert.tsx";
export { Badge } from "./components/ui/badge.tsx";
export { Separator } from "./components/ui/separator.tsx";
export { Checkbox } from "./components/ui/checkbox.tsx";
export { RadioGroup, RadioOption } from "./components/ui/radio-group.tsx";
