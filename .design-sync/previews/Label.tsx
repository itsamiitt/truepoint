import { Input, Label } from "@leadwolf/ui";

export function WithInput() {
  return (
    <div style={{ maxWidth: 320 }}>
      <Label htmlFor="work-email">Work email</Label>
      <Input id="work-email" type="email" placeholder="you@company.com" defaultValue="ada@acme.io" />
    </div>
  );
}

export function Fields() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 320 }}>
      <div>
        <Label htmlFor="full-name">Full name</Label>
        <Input id="full-name" placeholder="Jane Doe" defaultValue="Ada Lovelace" />
      </div>
      <div>
        <Label htmlFor="company">Company</Label>
        <Input id="company" placeholder="Acme Inc." defaultValue="Acme Inc." />
      </div>
    </div>
  );
}
