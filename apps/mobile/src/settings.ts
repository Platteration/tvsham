/**
 * The shape of user settings and the rules for trusting stored ones.
 * Free of storage and React so it can be tested directly.
 */
import { ACCENT_NAMES, isAccentName, type AccentName, type Appearance } from "./palette";

export interface Settings {
  serverUrl: string;
  token: string;
  /** Follow the system, or pin light / dark. */
  appearance: Appearance;
  /** Which accent pack the app draws with. */
  accent: AccentName;
  /** Accent packs the user owns. "midnight" ships with the app. */
  unlockedAccents: AccentName[];
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: "",
  token: "",
  appearance: "system",
  accent: "midnight",
  unlockedAccents: [...ACCENT_NAMES],
};

/**
 * Stored settings come from an older version of the app as often as not, so
 * anything that drives a colour lookup is checked before it is trusted.
 */
export function sanitise(s: Settings): Settings {
  const unlocked = Array.isArray(s.unlockedAccents) ? s.unlockedAccents.filter(isAccentName) : [];
  const accent: AccentName = isAccentName(s.accent) ? s.accent : "midnight";
  return {
    serverUrl: typeof s.serverUrl === "string" ? s.serverUrl : "",
    token: typeof s.token === "string" ? s.token : "",
    appearance: s.appearance === "light" || s.appearance === "dark" ? s.appearance : "system",
    accent,
    unlockedAccents: unlocked.length > 0 ? unlocked : [...ACCENT_NAMES],
  };
}
