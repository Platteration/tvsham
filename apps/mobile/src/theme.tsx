import { useMemo } from "react";
import { StyleSheet, useColorScheme } from "react-native";
import { paletteFor, type Palette } from "./palette";
import { useSettings } from "./store";

export * from "./palette";

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
