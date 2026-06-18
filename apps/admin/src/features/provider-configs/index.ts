// Public surface of the provider-configs admin slice (13 §3.6, ADR-0011): the screen the /provider-configs
// route renders. The admin shell (a sibling unit) mounts this; nothing else is public.
export { ProviderConfigsPage } from "./components/ProviderConfigsPage";
