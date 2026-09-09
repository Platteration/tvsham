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

/**
 * Stored settings come from an older version of the app as often as not, so
 * anything that drives a colour lookup is checked before it is trusted.
 */
export function sanitise(s: Settings): Settings {
  const unlocked = Array.isArray(s.unlockedAccents) ? s.unlockedAccents.filter(isAccentName) : [];
  const accent: AccentName = isAccentName(s.accent) ? s.accent : "midnight";
  return {
    serverUrl: cleanServerUrl(s.serverUrl),
    token: typeof s.token === "string" ? s.token : "",
    appearance: s.appearance === "light" || s.appearance === "dark" ? s.appearance : "system",
    accent,
    unlockedAccents: unlocked.length > 0 ? unlocked : [...ACCENT_NAMES],
  };
}
