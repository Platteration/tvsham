import { useMemo } from "react";
import { StyleSheet, useColorScheme } from "react-native";
import { useSettings } from "./store";

/** Every colour the app draws with. Both schemes define all of them. */
export interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  success: string;
  warning: string;
  danger: string;
  /** Brand colours for link badges; these stay fixed across schemes. */
  wikipedia: string;
  youtube: string;
  tiktok: string;
  instagram: string;
  /** Overlay text and rules drawn on top of the camera preview. */
  onCamera: string;
  onCameraDim: string;
}

/** Accent packs. The app ships with one; the rest are cosmetic unlocks. */
export const ACCENTS = {
  midnight: { label: "Midnight", accent: "#7c5cff", accentText: "#ffffff" },
  sunset: { label: "Sunset", accent: "#ff6b3d", accentText: "#ffffff" },
  forest: { label: "Forest", accent: "#1fb488", accentText: "#04231a" },
  mono: { label: "Mono", accent: "#e8e8ee", accentText: "#101018" },
} as const;

export type AccentName = keyof typeof ACCENTS;
export type Appearance = "system" | "light" | "dark";

export const ACCENT_NAMES = Object.keys(ACCENTS) as AccentName[];

export function isAccentName(v: string): v is AccentName {
  return v in ACCENTS;
}

const BRAND = {
  wikipedia: "#e8e8e8",
  youtube: "#ff3d3d",
  tiktok: "#25f4ee",
  instagram: "#e1306c",
  onCamera: "rgba(255,255,255,0.92)",
  onCameraDim: "rgba(0,0,0,0.6)",
} as const;

const DARK = {
  bg: "#0b0b10",
  surface: "#16161f",
  surfaceAlt: "#1f1f2b",
  border: "#2a2a38",
  text: "#f4f4f8",
  muted: "#9a9ab0",
  success: "#3ddc97",
  warning: "#ffb454",
  danger: "#ff5c7a",
} as const;

const LIGHT = {
  bg: "#f6f6fa",
  surface: "#ffffff",
  surfaceAlt: "#ececf3",
  border: "#dcdce6",
  text: "#14141c",
  muted: "#5d5d72",
  success: "#0f9d63",
  warning: "#b26a00",
  danger: "#d32f4f",
} as const;

export function paletteFor(scheme: "light" | "dark", accent: AccentName): Palette {
  const base = scheme === "dark" ? DARK : LIGHT;
  const { accent: accentColor, accentText } = ACCENTS[accent];
  return { ...base, ...BRAND, accent: accentColor, accentText };
}

/** The palette for the current appearance setting and accent choice. */
export function useTheme(): Palette {
  const system = useColorScheme();
  const { appearance, accent } = useSettings();
  const scheme = appearance === "system" ? (system === "light" ? "light" : "dark") : appearance;
  return useMemo(() => paletteFor(scheme, accent), [scheme, accent]);
}

/**
 * Styles that depend on the palette. Use in place of a module-level
 * `StyleSheet.create`, which would freeze one scheme's colours at import time.
 */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(factory: (c: Palette) => T): () => T {
  return function useStyles(): T {
    const c = useTheme();
    return useMemo(() => StyleSheet.create(factory(c)), [c]);
  };
}

export const radius = { sm: 8, md: 14, lg: 22, pill: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 20, xl: 32 } as const;
