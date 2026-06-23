import { Avatar } from "@leadwolf/ui";

export function Initials() {
  const names = ["Dana Whitfield", "Leah Ortiz", "Sam Park", "priya.menon@acme.com"];
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      {names.map((n) => (
        <Avatar key={n} name={n} size={40} />
      ))}
    </div>
  );
}

export function Sizes() {
  const sizes = [24, 32, 40, 56];
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
      {sizes.map((s) => (
        <Avatar key={s} name="Dana Whitfield" size={s} />
      ))}
    </div>
  );
}

export function InRow() {
  const people = [
    { name: "Dana Whitfield", role: "Account owner" },
    { name: "Leah Ortiz", role: "SDR" },
  ];
  return (
    <div style={{ display: "grid", gap: 12, maxWidth: 280 }}>
      {people.map((p) => (
        <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Avatar name={p.name} size={36} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--tp-ink)" }}>{p.name}</span>
            <span style={{ fontSize: 12, color: "var(--tp-ink-4)" }}>{p.role}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Stack() {
  const names = ["Dana Whitfield", "Leah Ortiz", "Sam Park"];
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      {names.map((n, i) => (
        <Avatar
          key={n}
          name={n}
          size={32}
          style={{ marginLeft: i === 0 ? 0 : -8, boxShadow: "0 0 0 2px var(--tp-surface)" }}
        />
      ))}
      <span style={{ marginLeft: 10, fontSize: 13, color: "var(--tp-ink-3)" }}>+5 more</span>
    </div>
  );
}
