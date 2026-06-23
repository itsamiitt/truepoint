import { Alert } from "@leadwolf/ui";

export function Note() {
  return (
    <div style={{ maxWidth: 380 }}>
      <Alert role="status">
        We sent a magic link to ada@acme.io. It expires in 15 minutes.
      </Alert>
    </div>
  );
}

export function Error() {
  return (
    <div style={{ maxWidth: 380 }}>
      <Alert variant="destructive" role="alert">
        That email or password is incorrect. Please try again.
      </Alert>
    </div>
  );
}

export function Variants() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 380 }}>
      <Alert role="status">Your changes have been saved.</Alert>
      <Alert variant="destructive" role="alert">
        Enter a valid work email address.
      </Alert>
    </div>
  );
}
