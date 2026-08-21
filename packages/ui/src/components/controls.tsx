// controls.tsx — the TruePoint token form-control family for apps/web. Tp-prefixed so they never clash with the
// auth-only shadcn Button/Input/Checkbox (those stay Tailwind-class based; these are token + primitives.css).
// Thin, typed wrappers over the .tp-ui-* classes — behavior is native; styling lives in primitives.css.
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "../cn.ts";
import { Spinner } from "./Spinner.tsx";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";

export interface TpButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  full?: boolean;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

/** Primary action button (Ink fill). Variants: primary · secondary · ghost · danger · link. */
export function TpButton({
  variant = "primary",
  size = "md",
  full = false,
  loading = false,
  leftIcon,
  rightIcon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: TpButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "tp-ui-btn",
        `tp-ui-btn--${variant}`,
        size === "sm" && "tp-ui-btn--sm",
        full && "tp-ui-btn--full",
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : leftIcon}
      {children}
      {rightIcon}
    </button>
  );
}

export interface TpIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required accessible name (also used as the title tooltip). */
  label: string;
}

/** A 32px square icon-only button (ghost). */
export function TpIconButton({
  label,
  className,
  type = "button",
  children,
  ...rest
}: TpIconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn("tp-ui-iconbtn", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface TpInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}
export function TpInput({ invalid, className, ...rest }: TpInputProps) {
  return (
    <input
      className={cn("tp-ui-field", invalid && "tp-ui-field--invalid", className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export interface TpTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}
export function TpTextarea({ invalid, className, ...rest }: TpTextareaProps) {
  return (
    <textarea
      className={cn("tp-ui-field", invalid && "tp-ui-field--invalid", className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export interface TpSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}
export function TpSelect({ invalid, className, children, ...rest }: TpSelectProps) {
  return (
    <select
      className={cn("tp-ui-field", invalid && "tp-ui-field--invalid", className)}
      aria-invalid={invalid || undefined}
      {...rest}
    >
      {children}
    </select>
  );
}

export interface TpCheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
}
export function TpCheckbox({ label, className, ...rest }: TpCheckboxProps) {
  return (
    <label className={cn("tp-ui-checkbox", className)}>
      <input type="checkbox" {...rest} />
      {label != null ? <span>{label}</span> : null}
    </label>
  );
}

export type TpSwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;
export function TpSwitch({ className, ...rest }: TpSwitchProps) {
  return (
    // biome-ignore lint/a11y/useAriaPropsForRole: the native checkbox supplies checkedness; a hardcoded aria-checked would desync uncontrolled usage
    <input type="checkbox" role="switch" className={cn("tp-ui-switch", className)} {...rest} />
  );
}

export interface TpChipProps {
  children: ReactNode;
  active?: boolean;
  /** When set the chip becomes a button (e.g. a filter facet). */
  onClick?: () => void;
  /** When set, renders a trailing × that calls this without triggering onClick. */
  onRemove?: () => void;
  /**
   * Accessible name for the remove control. Defaults to "Remove", which is fine for a lone chip and wrong
   * for a ROW of them: an applied-filter row announces eight identical "Remove" buttons, so a screen-reader
   * user cannot tell which filter they are about to drop. Callers rendering a set should name each one
   * ("Remove filter Industry: Software").
   */
  removeLabel?: string;
  className?: string;
}
export function TpChip({
  children,
  active,
  onClick,
  onRemove,
  removeLabel,
  className,
}: TpChipProps) {
  const remove =
    onRemove != null ? (
      <span
        className="tp-ui-chip-x"
        // biome-ignore lint/a11y/useSemanticElements: renders inside the chip's <button>; a nested <button> is invalid HTML
        role="button"
        aria-label={removeLabel ?? "Remove"}
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }
        }}
      >
        ×
      </span>
    ) : null;

  if (onClick != null) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "tp-ui-chip",
          "tp-ui-chip--button",
          active && "tp-ui-chip--active",
          className,
        )}
      >
        {children}
        {remove}
      </button>
    );
  }
  return (
    <span className={cn("tp-ui-chip", active && "tp-ui-chip--active", className)}>
      {children}
      {remove}
    </span>
  );
}
