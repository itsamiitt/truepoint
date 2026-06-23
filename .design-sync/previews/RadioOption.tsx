import { RadioGroup, RadioOption } from "@leadwolf/ui";

export function Selected() {
  return (
    <div style={{ maxWidth: 360 }}>
      <RadioGroup>
        <RadioOption name="org" value="acme" defaultChecked>
          Acme Inc.
        </RadioOption>
        <RadioOption name="org" value="globex">
          Globex Corporation
        </RadioOption>
      </RadioGroup>
    </div>
  );
}

export function States() {
  return (
    <div style={{ maxWidth: 360 }}>
      <RadioGroup>
        <RadioOption name="role" value="admin" defaultChecked>
          Admin — full access
        </RadioOption>
        <RadioOption name="role" value="member">
          Member — can edit contacts
        </RadioOption>
        <RadioOption name="role" value="billing" disabled>
          Billing — requires owner approval
        </RadioOption>
      </RadioGroup>
    </div>
  );
}
