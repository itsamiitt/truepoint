// css-shim.d.ts — CSS-module typing for the declaration-emit pass.
//
// The slice imports `styles from "../prospect.module.css"`. Next supplies that ambient type via
// next-env.d.ts; the standalone tsc project in build-ui.mjs doesn't include Next's types, so it declares
// the module here. Bundling doesn't need this — esbuild handles .module.css natively.
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
