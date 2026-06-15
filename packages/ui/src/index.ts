// Public surface of @leadwolf/ui — design tokens (./tokens.css), the Tailwind theme (./theme.css),
// the cn() helper, and the presentational + shadcn-pattern primitives. React/styling only; no logic.
export { cn } from "./cn.ts";

// Dashboard surface primitives (token-driven, inline-styled) — used by apps/web.
export { Card } from "./components/Card.tsx";
export { Spinner } from "./components/Spinner.tsx";
export { StatTile } from "./components/StatTile.tsx";
export { StatusBadge, type StatusTone } from "./components/StatusBadge.tsx";

// Tailwind/shadcn-pattern primitives — themed from the --tp-* tokens; no-JS friendly. Used by apps/auth.
export { Button, buttonVariants, type ButtonProps } from "./components/ui/button.tsx";
export { Input } from "./components/ui/input.tsx";
export { Label } from "./components/ui/label.tsx";
export { Alert } from "./components/ui/alert.tsx";
export { Badge } from "./components/ui/badge.tsx";
export { Separator } from "./components/ui/separator.tsx";
export { Checkbox } from "./components/ui/checkbox.tsx";
export { RadioGroup, RadioOption } from "./components/ui/radio-group.tsx";
