// SettingsPlaceholder.tsx — the neutral "being built" panel a settings route shows until its S-unit lands. Each
// S-unit replaces the placeholder page with the real surface; this keeps the scope nav from ever 404-ing.
import { EmptyState } from "@leadwolf/ui";

export function SettingsPlaceholder({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <section>
      <h1 className="tp-settings-title">{title}</h1>
      <EmptyState
        title="Coming soon"
        description={
          description ?? "This settings area is part of the dashboard redesign and is being built."
        }
      />
    </section>
  );
}
