// stubs/next-dynamic.tsx — next/dynamic, replaced by a React.lazy equivalent.
//
// WHY: next/dynamic ships as CommonJS that calls `require("react/jsx-runtime")` at module scope. esbuild
// emits that as `__require(...)`, which throws "Dynamic require of react/jsx-runtime is not supported" the
// moment the bundle is evaluated — killing the ENTIRE bundle, so all 71 cards (including the 44 primitives
// that never heard of next/dynamic) rendered empty. One CJS import, every card blank.
//
// The behaviour is preserved rather than faked: the loader still runs, the module still resolves
// asynchronously, and `options.loading` still renders while it does. What is dropped is `ssr: false`, which
// has no meaning in a browser-only preview — the component simply mounts.

import { type ComponentType, lazy, Suspense, createElement } from "react";

type Loader<P> = () => Promise<ComponentType<P> | { default: ComponentType<P> }>;

interface DynamicOptions<P> {
  loading?: ComponentType<{ error?: Error | null; isLoading?: boolean; pastDelay?: boolean }>;
  ssr?: boolean;
  // Accepted and ignored — a preview has no route-level chunking to name.
  [key: string]: unknown;
}

export default function dynamic<P extends object>(
  loader: Loader<P>,
  options: DynamicOptions<P> = {},
): ComponentType<P> {
  const Lazy = lazy(async () => {
    const mod = await loader();
    // next/dynamic accepts either a bare component or a module namespace with `default`.
    return { default: (mod as { default?: ComponentType<P> }).default ?? (mod as ComponentType<P>) };
  });
  const Loading = options.loading;
  return function DynamicComponent(props: P) {
    return createElement(
      Suspense,
      { fallback: Loading ? createElement(Loading, { isLoading: true, pastDelay: true }) : null },
      createElement(Lazy, props as P & { key?: never }),
    );
  };
}

/** next/dynamic also exports this for the app router; nothing in the previewed slices calls it. */
export const noSSR = dynamic;
