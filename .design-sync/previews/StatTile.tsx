import { StatTile } from "@leadwolf/ui";

export function Dashboard() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
      <StatTile label="Total leads" value="2,847" sublabel="+12% vs last month" />
      <StatTile label="Conversion rate" value="18.4%" sublabel="Across all sources" />
      <StatTile label="Pipeline value" value="$184,200" sublabel="64 open deals" />
    </div>
  );
}

export function WithTrend() {
  return (
    <div style={{ maxWidth: 280 }}>
      <StatTile
        label="Active contacts"
        value="1,204"
        trend={
          <span style={{ color: "var(--success)", fontSize: 13, fontWeight: 600 }}>↑ 8%</span>
        }
        sublabel="Synced 2 minutes ago"
      />
    </div>
  );
}
