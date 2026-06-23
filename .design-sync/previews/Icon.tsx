import { Icon } from "@leadwolf/ui";
import { Mail, Users, Calendar, Search, Settings, Building2, Phone, Send } from "./_glyphs";

export function Gallery() {
  const glyphs = [
    { icon: Mail, name: "Mail" },
    { icon: Users, name: "Users" },
    { icon: Calendar, name: "Calendar" },
    { icon: Search, name: "Search" },
    { icon: Settings, name: "Settings" },
    { icon: Building2, name: "Building2" },
    { icon: Phone, name: "Phone" },
    { icon: Send, name: "Send" },
  ];
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 24, color: "var(--tp-ink-2)" }}>
      {glyphs.map((g) => (
        <div key={g.name} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <Icon icon={g.icon} size={22} />
          <span style={{ fontSize: 11, color: "var(--tp-ink-4)" }}>{g.name}</span>
        </div>
      ))}
    </div>
  );
}

export function Sizes() {
  const sizes = [16, 20, 24, 32];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24, color: "var(--tp-ink-2)" }}>
      {sizes.map((s) => (
        <div key={s} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <Icon icon={Mail} size={s} />
          <span style={{ fontSize: 11, color: "var(--tp-ink-4)" }}>{s}px</span>
        </div>
      ))}
    </div>
  );
}

export function InContext() {
  const items = [
    { icon: Users, label: "Contacts" },
    { icon: Send, label: "Campaigns" },
    { icon: Calendar, label: "Schedule" },
  ];
  return (
    <div style={{ display: "grid", gap: 4, maxWidth: 220 }}>
      {items.map((it) => (
        <div
          key={it.label}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px",
            borderRadius: "var(--radius)",
            color: "var(--tp-ink-2)",
            fontSize: 13,
          }}
        >
          <Icon icon={it.icon} size={18} />
          <span>{it.label}</span>
        </div>
      ))}
    </div>
  );
}
