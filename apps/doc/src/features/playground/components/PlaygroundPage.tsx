"use client";

// PlaygroundPage.tsx — the sandbox console.
//
// It composes a request, runs it through the pure simulator in ../sandbox.ts, and shows exactly what a
// client would receive: the status, the body, what it charged, and the cURL to ship. Nothing here calls the
// network — see the sandbox module for why that is the design rather than a limitation.
//
// Two departures from the design mock, both deliberate:
//   • No fake latency. The mock rolled a random 140–460ms and printed it as the response time; a simulator
//     inventing a duration teaches a number nobody measured. The meta line says "simulated" instead, and the
//     call log has no duration column.
//   • Filled status pills carry the numeral in ink/cobalt/danger-700 rather than the mock's success and
//     warning fills, which fail the AA contrast floor under white type (contrast.test.ts).

import { CodeBlock } from "@/components/CodeBlock.tsx";
import { PageIntro } from "@/components/PageIntro.tsx";
import prose from "@/components/prose.module.css";
import { StatusBadge, TpButton, TpInput } from "@leadwolf/ui";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import styles from "../playground.module.css";
import type { SandboxEndpoint, SandboxOutcome, StoredReplay } from "../sandbox.ts";
import { buildCurl, simulate } from "../sandbox.ts";
import {
  SANDBOX_API_KEY,
  SANDBOX_BALANCE,
  SANDBOX_RECORDS,
  SANDBOX_SAMPLES,
} from "../sandboxRecords.ts";

interface HistoryEntry {
  readonly id: number;
  readonly status: number;
  readonly endpoint: string;
  readonly domain: string;
  readonly credits: number;
  readonly replayed: boolean;
}

const ENDPOINT_TABS: readonly {
  value: SandboxEndpoint;
  method: string;
  path: string;
  cost: string;
}[] = [
  { value: "match", method: "GET", path: "/company/match", cost: "free" },
  { value: "enrich", method: "POST", path: "/company/enrich", cost: "1 credit" },
];

/** Ink for a plain 200, cobalt for the one that spent a credit, danger for every error class. The numeral
 *  is always present, so the fill is reinforcement rather than the signal. */
function statusClass(status: number, credits: number): string {
  if (status >= 400) return styles.statusError ?? "";
  return (credits > 0 ? styles.statusBilled : styles.statusOk) ?? "";
}

export function PlaygroundPage() {
  const [endpoint, setEndpoint] = useState<SandboxEndpoint>("match");
  const [apiKey, setApiKey] = useState("");
  const [domain, setDomain] = useState("northgate.example.com");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [balance, setBalance] = useState(SANDBOX_BALANCE);
  const [replays, setReplays] = useState<Record<string, StoredReplay>>({});
  const [outcome, setOutcome] = useState<SandboxOutcome | null>(null);
  const [history, setHistory] = useState<readonly HistoryEntry[]>([]);

  const isEnrich = endpoint === "enrich";

  // Roving tabindex means only the SELECTED radio is in the tab order, so without arrow keys the other
  // endpoint is unreachable by keyboard entirely — Tab skips tabIndex={-1}, and nothing else selects it. This
  // shipped that way and was caught by driving the page in a browser: ArrowRight moved neither selection nor
  // focus. The WAI-ARIA radiogroup pattern is what makes the roving tabindex legitimate rather than a trap.
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const ARROW_DELTA: Record<string, number> = {
    ArrowRight: 1,
    ArrowDown: 1,
    ArrowLeft: -1,
    ArrowUp: -1,
  };

  function selectByKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = ARROW_DELTA[event.key];
    const target =
      delta === undefined
        ? event.key === "Home"
          ? 0
          : event.key === "End"
            ? ENDPOINT_TABS.length - 1
            : null
        : (index + delta + ENDPOINT_TABS.length) % ENDPOINT_TABS.length;
    if (target === null) return;

    // preventDefault so ArrowUp/ArrowDown select rather than scrolling the page out from under the reader.
    event.preventDefault();
    const next = ENDPOINT_TABS[target];
    if (!next) return;
    setEndpoint(next.value);
    setOutcome(null);
    // Focus follows selection — the pattern's other half. Without it the roving tabindex would move the tab
    // stop to a radio the user cannot see they are on.
    tabRefs.current[target]?.focus();
  }
  const curl = useMemo(
    () => buildCurl({ endpoint, apiKey, domain, idempotencyKey }),
    [endpoint, apiKey, domain, idempotencyKey],
  );

  function send() {
    const result = simulate({
      endpoint,
      apiKey,
      domain,
      idempotencyKey,
      balance,
      replays,
      records: SANDBOX_RECORDS,
    });
    setOutcome(result);
    setBalance((current) => current - result.chargedCredits);
    if (result.storeKey) {
      setReplays((current) => ({
        ...current,
        [result.storeKey as string]: { status: result.status, body: result.body },
      }));
    }
    setHistory((current) =>
      [
        {
          id: current.length ? (current[0]?.id ?? 0) + 1 : 1,
          status: result.status,
          endpoint: isEnrich ? "company.enrich" : "company.match",
          domain: domain.trim() || "—",
          credits: result.chargedCredits,
          replayed: result.replayed,
        },
        ...current,
      ].slice(0, 6),
    );
  }

  function reset() {
    setBalance(SANDBOX_BALANCE);
    setReplays({});
    setOutcome(null);
    setHistory([]);
  }

  const billedCalls = history.filter((entry) => entry.credits > 0).length;
  const creditsSpent = history.reduce((total, entry) => total + entry.credits, 0);

  return (
    <article>
      <PageIntro
        eyebrow="Documentation"
        title="Playground"
        lede="Fire both company endpoints and see what your integration will receive: the status code, the response body, what it charged, and the cURL you would ship. Every response is simulated against fabricated sample records — no live data, no real spend, and no key you enter here leaves the page."
        badge={<StatusBadge tone="warning">Simulated — nothing is sent</StatusBadge>}
      />

      <div className={styles.split}>
        <div className={styles.formColumn}>
          <div className={styles.panel}>
            <div className={styles.panelLabel} id="playground-endpoint-label">
              Endpoint
            </div>
            <div
              className={styles.endpointTabs}
              role="radiogroup"
              aria-labelledby="playground-endpoint-label"
            >
              {ENDPOINT_TABS.map((tab, index) => (
                <button
                  key={tab.value}
                  type="button"
                  role="radio"
                  aria-checked={endpoint === tab.value}
                  tabIndex={endpoint === tab.value ? 0 : -1}
                  ref={(node) => {
                    tabRefs.current[index] = node;
                  }}
                  className={styles.endpointTab}
                  onKeyDown={(event) => selectByKey(event, index)}
                  onClick={() => {
                    setEndpoint(tab.value);
                    setOutcome(null);
                  }}
                >
                  <span className={styles.endpointMethod}>{tab.method}</span>
                  <span className={styles.endpointPath}>{tab.path}</span>
                  <span className={styles.endpointCost}>{tab.cost}</span>
                </button>
              ))}
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="playground-key">
                API key
              </label>
              <div className={styles.fieldRow}>
                <TpInput
                  id="playground-key"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="tp_live_…"
                  aria-describedby="playground-key-hint"
                  spellCheck={false}
                  autoComplete="off"
                />
                <TpButton variant="secondary" onClick={() => setApiKey(SANDBOX_API_KEY)}>
                  Use sandbox key
                </TpButton>
              </div>
              <p className={styles.fieldHint} id="playground-key-hint">
                Sent as <span className={styles.mono}>Authorization: Bearer …</span>. Leave it blank
                to see the 401. The sandbox key is a fake string that only satisfies the shape check
                — never paste a real key into a browser.
              </p>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="playground-domain">
                Domain
              </label>
              <TpInput
                id="playground-domain"
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                placeholder="northgate.example.com"
                aria-describedby="playground-domain-hint"
                spellCheck={false}
                autoComplete="off"
              />
              <div className={styles.samples}>
                {SANDBOX_SAMPLES.map((sample) => (
                  <button
                    key={sample}
                    type="button"
                    className={styles.sampleChip}
                    onClick={() => setDomain(sample)}
                  >
                    {sample}
                  </button>
                ))}
              </div>
              <p className={styles.fieldHint} id="playground-domain-hint">
                Three of these are held in the sample set, one is the same record written as a full
                URL, and one is a miss. Anything that is not domain-shaped returns 422.
              </p>
            </div>

            {isEnrich ? (
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="playground-idempotency">
                  Idempotency-Key
                </label>
                <div className={styles.fieldRow}>
                  <TpInput
                    id="playground-idempotency"
                    value={idempotencyKey}
                    onChange={(event) => setIdempotencyKey(event.target.value)}
                    placeholder="optional, but recommended"
                    aria-describedby="playground-idempotency-hint"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <TpButton
                    variant="secondary"
                    onClick={() => setIdempotencyKey(crypto.randomUUID())}
                  >
                    Generate
                  </TpButton>
                </div>
                <p className={styles.fieldHint} id="playground-idempotency-hint">
                  Send the same request twice with one key to see the replay — the second call
                  returns the stored response and charges nothing.
                </p>
              </div>
            ) : null}

            <div className={styles.sendRow}>
              <TpButton variant="primary" onClick={send}>
                {isEnrich ? "Send request · 1 credit" : "Send request · free"}
              </TpButton>
              <span className={styles.balance}>
                Balance{" "}
                <span className={styles.balanceValue}>{balance.toLocaleString("en-US")}</span>{" "}
                credits
              </span>
              <button type="button" className={styles.resetButton} onClick={reset}>
                Reset sandbox
              </button>
            </div>
          </div>

          <section className={styles.usage} aria-label="This session's usage">
            <div className={styles.usageHead}>
              <h2 className={styles.usageTitle}>This session&rsquo;s usage</h2>
              <p className={styles.usageNote}>
                The same rollup the usage endpoint returns: calls, billed calls, credits.
              </p>
            </div>
            <div className={styles.usageGrid}>
              <div className={styles.usageCell}>
                <div className={styles.usageCellLabel}>Calls</div>
                <div className={styles.usageCellValue}>{history.length}</div>
              </div>
              <div className={styles.usageCell}>
                <div className={styles.usageCellLabel}>Billed</div>
                <div className={styles.usageCellValue}>{billedCalls}</div>
              </div>
              <div className={styles.usageCell}>
                <div className={styles.usageCellLabel}>Credits spent</div>
                <div className={styles.usageCellValue}>{creditsSpent}</div>
              </div>
            </div>
            {history.length ? (
              <div className={styles.historyWrap}>
                <table className={styles.history}>
                  <thead>
                    <tr>
                      <th scope="col">Status</th>
                      <th scope="col">Endpoint</th>
                      <th scope="col">Domain</th>
                      <th scope="col">Credits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((entry) => (
                      <tr key={entry.id}>
                        <td>
                          <span
                            className={`${styles.statusPill} ${statusClass(entry.status, entry.credits)}`}
                          >
                            {entry.status}
                          </span>
                        </td>
                        <td>
                          {entry.endpoint}
                          {entry.replayed ? " · replayed" : ""}
                        </td>
                        <td className={styles.historyDomain}>{entry.domain}</td>
                        <td className={styles.historyCredits}>
                          {entry.credits ? `-${entry.credits}` : "0"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        </div>

        <aside className={styles.aside} aria-label="Request and response">
          <CodeBlock language="Request · cURL" source={curl} />

          <div className={prose.codeWrap}>
            <div className={styles.responseHead}>
              <div className={styles.responseStatus}>
                {outcome ? (
                  <span
                    className={`${styles.statusPill} ${statusClass(outcome.status, outcome.chargedCredits)}`}
                  >
                    {outcome.status}
                    {outcome.replayed ? " · replayed" : ""}
                  </span>
                ) : (
                  <span className={styles.responseIdle}>idle</span>
                )}
                <span className={styles.responseMeta}>
                  {outcome ? "simulated · application/json" : "no request sent yet"}
                </span>
              </div>
            </div>
            <pre className={`${prose.code} ${styles.responseBody}`} aria-live="polite">
              <code>
                {outcome
                  ? JSON.stringify(outcome.body, null, 2)
                  : "// Pick an endpoint, add a key, send a request.\n// Responses appear here in the shape your client will receive."}
              </code>
            </pre>
          </div>

          {outcome ? <p className={styles.asideNote}>{outcome.note}</p> : null}

          <p className={styles.asideFooter}>
            Every field, code and price here mirrors the reference — see the{" "}
            <a href="/docs/errors">error vocabulary</a> and the{" "}
            <a href="/docs/api/company-enrich">enrich endpoint</a>.
          </p>
        </aside>
      </div>
    </article>
  );
}
