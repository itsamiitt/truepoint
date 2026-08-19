// OtpInput — the 6-digit MFA / email-verification code field.
//
// Progressive enhancement: with JS it strips non-digits as you type and auto-submits the form on the sixth
// digit; without JS the screen's own Verify button still works. Native <input>, centred, monospaced, wide
// letter-spacing, autoComplete="one-time-code" so a platform autofill can offer the code.
//
// The component takes no props and is uncontrolled, so `Entered` fills it through the real DOM node on
// mount. That is deliberate rather than a shortcut: assigning `.value` does not fire React's synthetic
// change event, so the auto-submit-on-six-digits behaviour is not triggered — the cell shows the field's
// typography without simulating a submit the card cannot honour.
import { OtpInput, SubmitButton } from "@leadwolf/ui";
import { useEffect, useRef } from "react";

const form: React.CSSProperties = {
  display: "grid",
  gap: 12,
  maxWidth: 360,
  padding: 20,
  background: "var(--tp-surface, #fff)",
  border: "1px solid var(--tp-hairline-2, #eceef1)",
  borderRadius: 10,
};

function Filled({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = ref.current?.querySelector("input");
    if (input) input.value = code;
  }, [code]);
  return (
    <div ref={ref}>
      <OtpInput />
    </div>
  );
}

/** A code entered: the mono, letter-spaced, centred treatment the field is designed around. */
export const Entered = () => (
  <form style={form}>
    <Filled code="482913" />
    <SubmitButton>Verify</SubmitButton>
  </form>
);

/** The resting state a user lands on, focused and waiting. */
export const Empty = () => (
  <form style={form}>
    <OtpInput />
    <SubmitButton>Verify</SubmitButton>
  </form>
);

/** The field alone — the shape a screen embeds when it supplies its own action row. */
export const FieldOnly = () => (
  <form style={form}>
    <OtpInput />
  </form>
);
