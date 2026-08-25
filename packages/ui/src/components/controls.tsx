"use client";
// controls.tsx — the TruePoint token form-control family. Tp-prefixed so they never clash with the
// shadcn-pattern Button/Input/Checkbox (which now render from the same primitives.css, in every app).
// Thin, typed wrappers over the .tp-ui-* classes — behavior is native; styling lives in primitives.css.
//
// "use client" is load-bearing: every control here takes an event handler, so a Server Component importing
// one and passing onClick would fail at runtime with no compile-time signal. It worked only because every
// consumer happened to already sit inside a client boundary.
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
/**
 * `children` is accepted as an alias for `label` — the documented API offered both, and passing children
 * used to CRASH: they were spread onto the `<input>`, which React rejects as a void element. Either spelling
 * now renders the same label text.
 */
export function TpCheckbox({ label, children, className, ...rest }: TpCheckboxProps) {
  const text = label ?? children;
  return (
    <label className={cn("tp-ui-checkbox", className)}>
      <input type="checkbox" {...rest} />
      {text != null ? <span>{text}</span> : null}
    </label>
  );
}

export interface TpSwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Optional trailing label. Without it, give the switch an `aria-label`. */
  label?: ReactNode;
}
/** Same children-vs-label story as TpCheckbox — passing children used to crash the void `<input>`. */
export function TpSwitch({ label, children, className, ...rest }: TpSwitchProps) {
  const text = label ?? children;
  const input = (
    // biome-ignore lint/a11y/useAriaPropsForRole: the native checkbox supplies checkedness; a hardcoded aria-checked would desync uncontrolled usage
    <input type="checkbox" role="switch" className={cn("tp-ui-switch", className)} {...rest} />
  );
  if (text == null) return input;
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is `input` above — a variable the rule cannot follow
    <label className="tp-ui-checkbox">
      {input}
      <span>{text}</span>
    </label>
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
  // A real <button>, and a SIBLING of the chip body rather than a child of it. The previous shape put a
  // role="button" span INSIDE the chip's own <button> — interactive content nested in a button is invalid
  // HTML with undefined assistive-tech behaviour (some ATs never expose the inner control at all). The
  // wrapper is now always a <span>, so both controls are peers.
  const remove =
    onRemove != null ? (
      <button
        type="button"
        className="tp-ui-chip-x"
        aria-label={removeLabel ?? "Remove"}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        ×
      </button>
    ) : null;

  return (
    <span className={cn("tp-ui-chip", active && "tp-ui-chip--active", className)}>
      {onClick != null ? (
        <button type="button" onClick={onClick} className="tp-ui-chip-body">
          {children}
        </button>
      ) : (
        children
      )}
      {remove}
    </span>
  );
}
