// oauthProviders.ts — register the configured email providers once at module load (M12 P1, D1). Delegates to
// core's registerEmailProviders (the single registration used by both apps/api and apps/workers): the Google
// OAuth provider (connect + refresh) when its client config is present — else the connect flow fails closed —
// and the Gmail send adapter. Imported for side-effect by the email routes (start) and the callback router.

import { registerEmailProviders } from "@leadwolf/core";

registerEmailProviders();
