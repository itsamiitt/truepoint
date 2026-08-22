// MachineReferencePage.tsx — the human page for the machine-readable contract.
//
// It exists so a developer can see exactly what their assistant will be given before they paste it, and so
// the file is discoverable from the navigation rather than only from a crawler convention. The document is
// rendered in full through the same CodeBlock the rest of the site uses, which is where the copy control
// comes from.

import { CodeBlock } from "@/components/CodeBlock.tsx";
import { Note } from "@/components/Note.tsx";
import { PageIntro } from "@/components/PageIntro.tsx";
import { MACHINE_REFERENCE_PATH, buildMachineReference } from "@/content/machineReference.ts";
import { StatusBadge } from "@leadwolf/ui";
import styles from "../machine-reference.module.css";

export function MachineReferencePage() {
  const document = buildMachineReference();
  const lines = document.split("\n").length;
  const kilobytes = (new TextEncoder().encode(document).length / 1024).toFixed(1);

  return (
    <article>
      <PageIntro
        eyebrow="Documentation"
        title="Machine reference"
        lede="The whole published contract as one plain-text document: every endpoint, parameter, return field, error code and worked example, plus the rules an integration most often gets wrong. Paste it into an assistant, or fetch it in a build step."
        badge={
          <StatusBadge tone="success">Generated from the same source as these pages</StatusBadge>
        }
      />

      <div className={styles.actions}>
        <a className="tp-ui-btn tp-ui-btn--primary" href={MACHINE_REFERENCE_PATH}>
          Open {MACHINE_REFERENCE_PATH}
        </a>
        <span className={styles.meta}>
          plain text · {lines} lines · {kilobytes} kB
        </span>
      </div>

      <div className={styles.body}>
        <Note tone="info">
          Prefer this file over scraping the HTML. These pages carry navigation and layout an
          assistant has to guess its way through; this one is the contract with nothing else in it,
          and it is generated from the same typed content the pages render — so it cannot quietly
          disagree with them.
        </Note>

        <h2 className={styles.heading}>What is in it</h2>
        <ul className={styles.list}>
          <li>
            Connection facts: base URL, the bearer scheme, the required scope, the error format.
          </li>
          <li>
            Every endpoint with its availability stated in words — a planned endpoint says it is not
            callable yet, so nothing writes code against a response that does not exist.
          </li>
          <li>Parameters, return fields and the full error vocabulary, per endpoint.</li>
          <li>
            The credit cost of each action, and the plan table with the date it was last reviewed.
          </li>
          <li>
            The route to privacy@truepoint.in, because a machine reader needs to find that too.
          </li>
        </ul>

        <h2 className={styles.heading}>Keeping it current</h2>
        <p className={styles.paragraph}>
          Fetch it at build time rather than pinning a copy. It is regenerated with every deploy, so
          a stale copy is the one way to end up with a field name we no longer publish.
        </p>

        <h2 className={styles.heading}>The document</h2>
      </div>

      <CodeBlock language={`text · ${MACHINE_REFERENCE_PATH}`} source={document} />
    </article>
  );
}
