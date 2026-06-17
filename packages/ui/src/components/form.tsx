// form.tsx — consistent form scaffolding so every settings panel + builder form reads the same: a titled
// FormSection, a labeled FieldGroup (label · control · hint/error), and a two-column FormRow (label | control).
// Pure layout over the .tp-ui-form-* classes in primitives.css. Label↔control association is the caller's
// (pass htmlFor + a matching id) so these stay server-component friendly (no useId hook).
import type { ReactNode } from "react";
import { cn } from "../cn.ts";

export function FormSection({
  title,
  description,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("tp-ui-form-section", className)}>
      {title != null || description != null ? (
        <header className="tp-ui-form-section-head">
          {title != null ? <h2 className="tp-ui-form-section-title">{title}</h2> : null}
          {description != null ? <p className="tp-ui-form-section-desc">{description}</p> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function FieldGroup({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Match the control's id for an explicit label↔control association. */
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("tp-ui-field-group", className)}>
      {label != null ? (
        <label className="tp-ui-field-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      {children}
      {error != null ? (
        <span className="tp-ui-field-error">{error}</span>
      ) : hint != null ? (
        <span className="tp-ui-field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function FormRow({
  label,
  description,
  children,
  className,
}: {
  label?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("tp-ui-form-row", className)}>
      <div className="tp-ui-field-group">
        {label != null ? <span className="tp-ui-field-label">{label}</span> : null}
        {description != null ? <span className="tp-ui-field-hint">{description}</span> : null}
      </div>
      <div>{children}</div>
    </div>
  );
}
