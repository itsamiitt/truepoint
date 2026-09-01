// CompanyTab.tsx — the company half of the panel: who they are, and the one thing the licensed record says
// better than any page does — headcount over time.
//
// Everything here is firmographic. No personal data crosses into this tab, which is why it can render for a
// company page where there is no person at all.
//
// The growth numbers are DERIVED on the client (intel/headcount.ts) because the platform deliberately stores
// only the monthly series — a stored rollup is a second copy that drifts. The sentence under the change rows
// exists because the headline number hides the most useful read: a company at +194% that stopped moving last
// month is a different conversation from one still climbing.
import { t } from "../../i18n/index.ts";
import { monogram, monthLabel, signedPct } from "../../shared/intel/format.ts";
import { headcountRead, headcountWindows, sparkline } from "../../shared/intel/headcount.ts";
import type { IntelPayload } from "../../shared/messages.ts";
import {
  Chip,
  EmptyBlock,
  KeyValue,
  SectionLabel,
  Skeleton,
  cobalt,
  hairline,
  ink,
  ink2,
  ink3,
  mono,
  surface3,
} from "./primitives.tsx";

function CompanySkeleton(): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, paddingTop: 6 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Skeleton width={40} height={40} radius={9} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          <Skeleton width="46%" height={15} />
          <Skeleton width="70%" height={11} />
        </div>
      </div>
      {/* Radii track the cards these stand in (--tp-radius-card), so nothing reflows when data lands. */}
      <Skeleton width="100%" height={96} radius={14} />
      <Skeleton width="100%" height={120} radius={14} />
    </div>
  );
}

/** The 25-bar monthly series. Each bar carries its own month + count as a title for hover and for AT. */
function Sparkline({ payload }: { payload: IntelPayload }): React.ReactElement | null {
  const series = payload.intel.company?.headcountSeries ?? [];
  const bars = sparkline(series, 25);
  if (bars.length === 0) return null;
  const first = bars[0];
  const last = bars.at(-1);

  return (
    <div>
      <div
        style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 64, marginTop: 14 }}
        role="img"
        aria-label={t("company.seriesAria")
          .replace("{from}", `${monthLabel(first?.month) ?? ""} ${first?.count ?? ""}`)
          .replace("{to}", `${monthLabel(last?.month) ?? ""} ${last?.count ?? ""}`)}
      >
        {bars.map((b) => (
          <span
            key={b.month}
            title={`${monthLabel(b.month)} · ${b.count}`}
            style={{
              flex: 1,
              background: cobalt,
              opacity: 0.28,
              borderRadius: "2px 2px 0 0",
              minHeight: 2,
              height: `${b.heightPct}%`,
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 6,
          fontSize: 11,
          color: ink3,
        }}
      >
        <span>{`${monthLabel(first?.month) ?? ""} · ${first?.count ?? ""}`}</span>
        <span>{`${monthLabel(last?.month) ?? ""} · ${last?.count ?? ""}`}</span>
      </div>
    </div>
  );
}

export function CompanyTab({
  payload,
  loading,
}: {
  payload: IntelPayload | null;
  loading: boolean;
}): React.ReactElement {
  if (loading || !payload) return <CompanySkeleton />;

  const block = payload.intel.company;
  if (!block) {
    return <EmptyBlock title={t("company.emptyTitle")} hint={t("company.emptyHint")} />;
  }
  const c = block.company;
  const series = block.headcountSeries;
  const windows = headcountWindows(series);
  const oneYear = windows.find((w) => w.months === 12);
  const read = headcountRead(series);
  const offices = block.locations
    .map((l) => l.city)
    .filter((v): v is string => Boolean(v))
    .slice(0, 3);
  // The signals deriver decides when a revenue band has been outrun by headcount; the Details row reuses that
  // verdict rather than inventing a second rule.
  const revenueStale =
    c.revenueDisplay &&
    c.employeeCount !== null &&
    (series[0]?.employeeCount ?? 0) > 0 &&
    c.employeeCount >= (series[0]?.employeeCount ?? 0) * 2;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div style={{ display: "flex", gap: 13, alignItems: "center", paddingTop: 4 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 9,
            background: surface3,
            flex: "none",
            overflow: "hidden",
            display: "grid",
            placeItems: "center",
            fontSize: 15,
            fontWeight: 600,
            // The monogram IS the logo when there is none — text on a tile, not a watermark. ink2 rather
            // than the ink3 the rest of the muted copy takes: this tile is --tp-surface-3, where ink3
            // measures 4.43:1 and falls under AA's 4.5 (ink4 was 2.33:1).
            color: ink2,
          }}
        >
          {/* A company logo IS mapped into the record (unlike a person's photo), so it can be shown. It
              falls back to a monogram when absent or when the image fails to load. */}
          {c.logoUrl ? (
            <img
              src={c.logoUrl}
              alt=""
              referrerPolicy="no-referrer"
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          ) : (
            monogram(c.name)
          )}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{ fontSize: 18, fontWeight: 650, letterSpacing: "-0.02em", lineHeight: 1.15 }}
          >
            {c.name}
          </div>
          <div style={{ fontSize: 12, color: ink2, marginTop: 3 }}>
            {[c.industryLabel ?? c.industry, c.primaryDomain].filter(Boolean).join(" · ")}
          </div>
        </div>
      </div>

      {series.length > 0 ? (
        <div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <div>
              <span style={{ fontSize: 26, fontWeight: 650, letterSpacing: "-0.03em", ...mono }}>
                {series.at(-1)?.employeeCount ?? c.employeeCount}
              </span>
              <span style={{ fontSize: 12, color: ink3, marginLeft: 7 }}>
                {t("company.employees")}
              </span>
            </div>
            {oneYear?.pct !== null && oneYear?.pct !== undefined ? (
              <div style={{ fontSize: 13, fontWeight: 600, color: cobalt }}>
                {signedPct(oneYear.pct)}{" "}
                <span style={{ fontWeight: 500, color: ink3 }}>{t("company.twelveMonths")}</span>
              </div>
            ) : null}
          </div>
          <Sparkline payload={payload} />
        </div>
      ) : null}

      {windows.length > 0 ? (
        <div>
          <SectionLabel>{t("company.changeLabel")}</SectionLabel>
          {windows.map((w) => (
            <div
              key={w.months}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 0",
                borderBottom: `1px solid ${hairline}`,
              }}
            >
              <span style={{ width: 42, flex: "none", fontSize: 13, fontWeight: 600 }}>
                {t(`company.window.${w.months}` as Parameters<typeof t>[0])}
              </span>
              <span style={{ flex: 1, fontSize: 12, color: ink3 }}>
                {w.from === null ? t("company.noBaseline") : `${w.from} → ${w.to}`}
              </span>
              {/* Tone is an emphasis, never the message: the signed percentage is the meaning, and it is
                  present in text for every row. */}
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  ...mono,
                  // The signed percentage IS the message (the tone only emphasises it), so even the quietest
                  // grade has to be legible: ink4 is 2.54:1 and fails AA.
                  color: w.strength === "strong" ? cobalt : w.strength === "mild" ? ink : ink3,
                }}
              >
                {signedPct(w.pct) ?? "—"}
              </span>
            </div>
          ))}
          <div style={{ marginTop: 9, fontSize: 12, color: ink3, lineHeight: 1.5 }}>
            {read.key === "flatAfterGrowth"
              ? t("company.read.flatAfterGrowth").replace("{months}", String(read.months))
              : read.key === "growing"
                ? t("company.read.growing").replace("{pct}", String(read.pct))
                : read.key === "declining"
                  ? t("company.read.declining").replace("{pct}", String(Math.abs(read.pct)))
                  : read.key === "steady"
                    ? t("company.read.steady")
                    : t("company.read.insufficient")}
          </div>
        </div>
      ) : null}

      {c.description ? (
        <div>
          <SectionLabel>{t("company.about")}</SectionLabel>
          <div style={{ fontSize: 13, color: ink2, lineHeight: 1.6, textWrap: "pretty" }}>
            {c.description}
          </div>
        </div>
      ) : null}

      <div>
        <SectionLabel>{t("company.details")}</SectionLabel>
        {c.ownershipType ? (
          <KeyValue label={t("company.detail.type")}>{c.ownershipType}</KeyValue>
        ) : null}
        {c.yearFounded ? (
          <KeyValue label={t("company.detail.founded")}>{c.yearFounded}</KeyValue>
        ) : null}
        {c.hqCity || c.hqCountry ? (
          <KeyValue label={t("company.detail.hq")}>
            {[c.hqCity, c.hqCountry].filter(Boolean).join(", ")}
          </KeyValue>
        ) : null}
        {offices.length > 0 ? (
          <KeyValue label={t("company.detail.offices")}>{offices.join(" · ")}</KeyValue>
        ) : null}
        {c.employeeCount !== null ? (
          <KeyValue label={t("company.detail.employees")}>
            {series.at(-1)?.month
              ? `${c.employeeCount} (${monthLabel(series.at(-1)?.month)})`
              : c.employeeCount}
          </KeyValue>
        ) : null}
        {c.revenueDisplay ? (
          <KeyValue label={t("company.detail.revenue")}>
            {c.revenueDisplay}
            {revenueStale ? (
              <span style={{ color: ink3 }}> · {t("company.detail.likelyStale")}</span>
            ) : null}
          </KeyValue>
        ) : null}
      </div>

      {c.specialties.length > 0 ? (
        <div>
          {/* SPECIALTIES, not "stated integrations": this is a real, mapped field. Mining the description
              for tool names would be an inference dressed as a fact, and the panel does not do that. */}
          <SectionLabel>{t("company.specialties")}</SectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {c.specialties.map((s) => (
              <Chip key={s}>{s}</Chip>
            ))}
          </div>
          <div style={{ marginTop: 9, fontSize: 12, color: ink3, lineHeight: 1.5 }}>
            {t("company.specialtiesNote")}
          </div>
        </div>
      ) : null}

      <div style={{ ...mono, fontSize: 11, color: ink3, lineHeight: 1.7 }}>
        {/* URL-shaped identity only. The numeric LinkedIn company id is internal link metadata and never
            appears in a customer-facing surface. */}
        {c.primaryDomain}
        <br />
        {t("company.meta")
          .replace("{captured}", c.updatedAt.slice(0, 10))
          .replace("{asOf}", monthLabel(series.at(-1)?.month) ?? "—")}
      </div>
    </div>
  );
}
