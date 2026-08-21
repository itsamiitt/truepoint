// palette.ts — the CommandPalette's own entry point (perf-checklist PA-3). The palette (cmdk + its lucide
// set, ~17.3kB gz) is a Cmd-K surface behind user intent, but importing it through the main barrel welded it
// into every authenticated route's first load: a `next/dynamic` of the SAME barrel the shell also imports
// statically splits nothing — the split needs a module the static graph doesn't reach. This subpath is that
// module; the shell dynamics `@leadwolf/app-shell/palette` and everything else keeps using the barrel.

export { CommandPalette } from "../CommandPalette.tsx";
export type { PaletteAction } from "../CommandPalette.tsx";
