import { Input } from "@leadwolf/ui";

export function Default() {
  return (
    <div style={{ maxWidth: 320 }}>
      <Input type="email" placeholder="you@company.com" defaultValue="ada@acme.io" />
    </div>
  );
}

export function Types() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 320 }}>
      <Input type="text" placeholder="Full name" defaultValue="Ada Lovelace" />
      <Input type="email" placeholder="Work email" defaultValue="ada@acme.io" />
      <Input type="password" placeholder="Password" defaultValue="correct-horse" />
      <Input type="search" placeholder="Search contacts" />
    </div>
  );
}

export function States() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 320 }}>
      <Input placeholder="Empty (placeholder only)" />
      <Input defaultValue="Filled value" />
      <Input aria-invalid defaultValue="not-an-email" />
      <Input disabled defaultValue="Locked field" />
    </div>
  );
}
