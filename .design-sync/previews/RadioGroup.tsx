import { RadioGroup, RadioOption } from "@leadwolf/ui";

export function PlanPicker() {
  return (
    <div style={{ maxWidth: 360 }}>
      <RadioGroup>
        <RadioOption name="plan" value="starter" defaultChecked>
          <span>
            <strong style={{ display: "block", fontSize: 14 }}>Starter</strong>
            <span style={{ fontSize: 13, color: "var(--tp-ink-3)" }}>Up to 1,000 contacts</span>
          </span>
        </RadioOption>
        <RadioOption name="plan" value="growth">
          <span>
            <strong style={{ display: "block", fontSize: 14 }}>Growth</strong>
            <span style={{ fontSize: 13, color: "var(--tp-ink-3)" }}>Up to 25,000 contacts</span>
          </span>
        </RadioOption>
        <RadioOption name="plan" value="scale">
          <span>
            <strong style={{ display: "block", fontSize: 14 }}>Scale</strong>
            <span style={{ fontSize: 13, color: "var(--tp-ink-3)" }}>Unlimited contacts</span>
          </span>
        </RadioOption>
      </RadioGroup>
    </div>
  );
}

export function WorkspacePicker() {
  return (
    <div style={{ maxWidth: 360 }}>
      <RadioGroup>
        <RadioOption name="workspace" value="acme" defaultChecked>
          Acme Inc.
        </RadioOption>
        <RadioOption name="workspace" value="globex">
          Globex Corporation
        </RadioOption>
        <RadioOption name="workspace" value="initech" disabled>
          Initech (no access)
        </RadioOption>
      </RadioGroup>
    </div>
  );
}
