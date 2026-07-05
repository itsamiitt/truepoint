// Ambient module declarations for Vite asset imports used in source (typechecked by `tsc --noEmit`).
declare module "*?inline" {
  const content: string;
  export default content;
}
declare module "*.css" {
  const content: string;
  export default content;
}
declare module "*.png" {
  const url: string;
  export default url;
}
