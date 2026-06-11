// cn.ts — the standard class-name merge helper (clsx + tailwind-merge) used by every UI component.
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
