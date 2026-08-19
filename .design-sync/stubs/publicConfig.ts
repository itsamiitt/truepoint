// stubs/publicConfig.ts - the build-inlined public config the slice reads.
//
// The real module reads process.env.NEXT_PUBLIC_* (inlined by the Next build) and derives APP_ORIGIN from
// window.location. There is no Next build here and no process global in the bundle, so these are constants.
//
// API_BASE stays "" so every request URL the slice builds is same-origin and relative - which is exactly what
// the router in ./authClient matches on. The two ORIGINS are the real ones, because they are rendered as
// COPY rather than fetched: the OAuth panel tells you redirect URIs must resolve on the auth origin, and an
// empty string turned that sentence into "must resolve on .".
export const AUTH_ORIGIN = "https://auth.truepoint.in";
export const APP_ORIGIN = "https://app.truepoint.in";
export const API_BASE = "";
