"use client";
// DensityProvider.tsx — owns the comfortable/compact table density (04 §8, 24 §7). Sets data-density on a
// wrapper so the [data-density="compact"] rules in @leadwolf/ui/primitives.css apply app-wide, and persists the
// choice to localStorage. The wrapper uses display:contents so it never affects layout.
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";

type Density = "comfortable" | "compact";

interface DensityApi {
  density: Density;
  toggle: () => void;
  setDensity: (d: Density) => void;
}

const DensityContext = createContext<DensityApi | null>(null);
const STORAGE_KEY = "tp-density";

export function DensityProvider({ children }: { children: ReactNode }) {
  const [density, setDensity] = useState<Density>("comfortable");

  // Hydrate from localStorage after mount (avoids SSR/client mismatch).
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "compact" || saved === "comfortable") setDensity(saved);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, density);
  }, [density]);

  const toggle = () => setDensity((d) => (d === "compact" ? "comfortable" : "compact"));

  return (
    <DensityContext.Provider value={{ density, toggle, setDensity }}>
      <div data-density={density} style={{ display: "contents" }}>
        {children}
      </div>
    </DensityContext.Provider>
  );
}

export function useDensity(): DensityApi {
  const ctx = useContext(DensityContext);
  if (!ctx) throw new Error("useDensity must be used within a <DensityProvider>");
  return ctx;
}
