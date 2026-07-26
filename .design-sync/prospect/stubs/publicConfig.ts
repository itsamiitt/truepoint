// stubs/publicConfig.ts — the build-inlined public config the slice reads.
//
// The real module reads process.env.NEXT_PUBLIC_* (inlined by the Next build) and derives APP_ORIGIN from
// window.location. There is no Next build here and no process global in the bundle, so these are constants.
// API_BASE stays "" so every request URL the slice builds is same-origin and relative — which is exactly
// what the fetch stub in ./authClient matches on.
export const AUTH_ORIGIN = "";
export const APP_ORIGIN = "";
export const API_BASE = "";
