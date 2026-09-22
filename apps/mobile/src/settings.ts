/**
 * The shape of user settings, the rules for trusting stored ones, and the name
 * of every record the app keeps on the device.
 * Free of storage and React so it can be tested directly.
 */
import { ACCENTS, ACCENT_NAMES, type AccentName, type Appearance } from "./palette";

/**
 * Every key the app writes on the device, so a rename is a change to one
 * table that `settings-contract.test.ts` pins, never a stray string in a
 * screen. `<app>.<record>.v<N>`: the version is for the record's format.
 */
export const KEYS = {
  settings: "tvsham.settings.v1",
  library: "tvsham.library.v1",
  history: "tvsham.history.v1",
  device: "tvsham.device.v1",
  /** Clips recorded while the server was out of reach; the files are beside it on disk. */
  queue: "tvsham.queue.v1",
  /**
   * The server token is a shared secret for a paid service, so it lives in the
   * keychain (expo-secure-store) rather than AsyncStorage, which is a plain
   * file that device backups include. Everything else is preferences and stays
   * where it is.
   */
  token: "tvsham.token.v1",
} as const;

/** Decorative motion: follow the phone's accessibility setting, or pin it. */
export type ReduceMotion = "system" | "on" | "off";

export interface Settings {
  serverUrl: string;
  token: string;
  /** Follow the system, or pin light / dark. */
  appearance: Appearance;
  /** Which accent pack the app draws with. */
  accent: AccentName;
  /** Accent packs the user owns. "midnight" ships with the app. */
  unlockedAccents: AccentName[];
  /** Vibrate when a clip starts, when a result is in and when something is saved. */
  haptics: boolean;
  /** Still the sonar rings and the breathing capture button. */
  reduceMotion: ReduceMotion;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: "",
  token: "",
  appearance: "system",
  accent: "midnight",
  unlockedAccents: [...ACCENT_NAMES],
  haptics: true,
  reduceMotion: "system",
};

/**
 * The enum tables. `Record<Union, true>` rather than a list of strings, so a
 * member added to the type without a row here fails the type check instead of
 * being dropped by the validator on every launch.
 */
export const APPEARANCES: Record<Appearance, true> = { system: true, light: true, dark: true };
export const REDUCE_MOTION: Record<ReduceMotion, true> = { system: true, on: true, off: true };

export const APPEARANCE_NAMES = Object.keys(APPEARANCES) as Appearance[];
export const REDUCE_MOTION_NAMES = Object.keys(REDUCE_MOTION) as ReduceMotion[];

type Fields = Record<string, unknown>;

function fields(raw: unknown): Fields {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Fields) : {};
}

/**
 * True when `value` is one of `table`'s own keys - never an inherited one. A
 * table is a plain object, so `value in table` is true for every name on
 * Object.prototype ("constructor", "__proto__", "toString") and a stored
 * appearance of "toString" would pass and reach the palette as a scheme that
 * is not one. The typeof check is what keeps an object out of the lookup:
 * used as a property key it is coerced through its own toString, which a
 * stored record can make throw.
 */
function has<T extends string>(table: Record<T, unknown>, value: unknown): value is T {
  if (typeof value !== "string") return false;
  return Object.prototype.hasOwnProperty.call(table, value);
}

/** `value` when it is one of `table`'s own keys, else `fallback`. */
function pick<T extends string>(value: unknown, table: Record<T, unknown>, fallback: T): T {
  return has(table, value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * A server address the app is willing to talk to: an absolute URL with an
 * http(s) scheme and a host, and nothing else. Everything the app sends - the
 * recorded clip, the access token, the device id - goes to this address, and
 * everything it renders comes back from it, so a stored value that is not a web
 * URL is dropped rather than handed to fetch.
 */
export function cleanServerUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!url.hostname) return "";
    return trimmed;
  } catch {
    return "";
  }
}

/**
 * Hosts that cannot be reached from outside the user's own network. Plain HTTP
 * to one of these is the app's normal case - a server on the LAN, which cannot
 * have a public certificate - while plain HTTP to anything else crosses
 * networks the user does not control.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT range, used by mesh VPNs
    return false;
  }
  if (host === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // unique local
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // link-local
  return false;
}

/**
 * Whether the access token may be sent to this server. It is a shared secret
 * for something that spends money, so over plain HTTP it only goes to an
 * address that cannot leave the local network; anyone on a shared Wi-Fi could
 * otherwise read it straight off the wire.
 */
export function canSendTokenTo(serverUrl: string): boolean {
  const url = cleanServerUrl(serverUrl);
  if (!url) return false;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" || isPrivateHost(hostname);
  } catch {
    return false;
  }
}

/** What is wrong with the server URL the user typed, in words, or null. */
export function serverUrlWarning(raw: string): string | null {
  if (!raw.trim()) return null;
  const url = cleanServerUrl(raw);
  if (!url) return "That is not a server address. Use http://host:port or https://host.";
  if (canSendTokenTo(url)) return null;
  return (
    "This address is not on your own network and is not HTTPS. Clips and results would be sent in the clear, " +
    "so the access token will not be sent at all. Use https:// for a server outside your network."
  );
}

/** Accent packs the record says the user owns, keeping only names the app has. */
function cleanUnlocked(raw: unknown, fallback: AccentName[]): AccentName[] {
  const list = Array.isArray(raw) ? raw.filter((v): v is AccentName => has(ACCENTS, v)) : fallback;
  // Never leave the user with no accent at all.
  return list.length > 0 ? [...list] : [...ACCENT_NAMES];
}

/**
 * Stored settings come from an older version of the app as often as not, and
 * on a shared storage origin from no version of it at all, so every field is
 * checked before it is trusted. A field that fails takes the fallback's value
 * for that field, never the whole record: `fallback` is the settings in force
 * (the defaults at launch, the previous value on an update), so one bad field
 * costs the user one field. The server URL is the exception the comment on
 * `cleanServerUrl` explains: a string that is not a web address becomes "".
 */
export function cleanSettings(raw: unknown, fallback: Settings): Settings {
  const s = fields(raw);
  return {
    serverUrl: typeof s.serverUrl === "string" ? cleanServerUrl(s.serverUrl) : fallback.serverUrl,
    token: typeof s.token === "string" ? s.token : fallback.token,
    appearance: pick(s.appearance, APPEARANCES, fallback.appearance),
    accent: pick(s.accent, ACCENTS, fallback.accent),
    unlockedAccents: cleanUnlocked(s.unlockedAccents, fallback.unlockedAccents),
    haptics: bool(s.haptics, fallback.haptics),
    reduceMotion: pick(s.reduceMotion, REDUCE_MOTION, fallback.reduceMotion),
  };
}

/**
 * Whether decorative motion should be stilled: the setting when it is pinned,
 * the phone's own accessibility answer when it says to follow the system.
 */
export function shouldReduceMotion(setting: ReduceMotion, system: boolean): boolean {
  return setting === "system" ? system : setting === "on";
}

/**
 * The fields Reset to defaults touches: what the app looks and feels like.
 * The server address and token are connection configuration and the unlocked
 * accents are purchases; neither is a preference, so neither is reset.
 */
export const PREFERENCE_FIELDS = ["appearance", "accent", "haptics", "reduceMotion"] as const;

/** Reset to defaults: exactly `PREFERENCE_FIELDS` go back to how the app shipped. */
export function resetPreferences(current: Settings): Settings {
  const next: Settings = { ...current, unlockedAccents: [...current.unlockedAccents] };
  for (const field of PREFERENCE_FIELDS) Object.assign(next, { [field]: DEFAULT_SETTINGS[field] });
  return next;
}
