import { Pagination } from "@leadwolf/ui";

export function Middle() {
  return (
    <div style={{ maxWidth: 320 }}>
      <Pagination hasPrev hasNext label="26–50 of 312" onPrev={() => {}} onNext={() => {}} />
    </div>
  );
}

export function FirstPage() {
  return (
    <div style={{ maxWidth: 320 }}>
      <Pagination hasPrev={false} hasNext label="1–25 of 312" onNext={() => {}} />
    </div>
  );
}

export function LastPage() {
  return (
    <div style={{ maxWidth: 320 }}>
      <Pagination hasPrev hasNext={false} label="301–312 of 312" onPrev={() => {}} />
    </div>
  );
}

export function InCardFooter() {
  return (
    <div
      style={{
        maxWidth: 420,
        background: "var(--tp-surface-2)",
        border: "1px solid var(--tp-hairline-2)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "14px 16px", fontSize: 13, color: "var(--tp-ink-2)" }}>
        Showing imported contacts from the latest sync.
      </div>
      <div
        style={{
          padding: "10px 16px",
          borderTop: "1px solid var(--tp-hairline-2)",
          background: "var(--tp-surface)",
          display: "flex",
          justifyContent: "flex-end",
        }}
      >
        <Pagination hasPrev hasNext label="Page 2 of 8" onPrev={() => {}} onNext={() => {}} />
      </div>
    </div>
  );
}
