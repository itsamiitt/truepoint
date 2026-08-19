// CreditsTab - the billing Credits tab: the balance and the top-up packs.
//
// `canPurchase` is the permission gate - a member who cannot buy sees the packs but cannot act, rather than
// having the tab hidden from them.
import { CreditsTab } from "@leadwolf/ui";
import { Frame } from "./_webPage";

const topUp = async () => null;

/** An admin who can purchase. */
export const CanPurchase = () => (
  <Frame>
    <CreditsTab balance={12_480} topUp={topUp} />
  </Frame>
);

/** A member who cannot: the packs are visible, the action is not available. */
export const ReadOnly = () => (
  <Frame>
    <CreditsTab balance={12_480} topUp={topUp} canPurchase={false} />
  </Frame>
);

/** Balance not yet resolved - an em dash, never a fabricated zero. */
export const Unknown = () => (
  <Frame>
    <CreditsTab balance={null} topUp={topUp} />
  </Frame>
);
