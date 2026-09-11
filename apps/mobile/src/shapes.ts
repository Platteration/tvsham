/**
 * The shapes the app is willing to render, and how anything else is coerced
 * into them.
 *
 * Everything handled here came from outside the app. The server is reached over
 * plain HTTP by default, so on a shared network somebody else can choose what a
 * response says; the saved library, the history and the offline queue were
 * written by an older build, or half-written by one the OS killed. The screens
 * then reach deep into these values — `result.links.map`, `item.links.find`,
 * `item.identification.title` — where an array that is not an array is a
 * TypeError and a blank screen, and because whatever arrived is also persisted,
 * that blank screen survives a restart with no way back inside the app.
 *
 * Settings get `sanitise` for exactly this reason. This is the same idea for
 * everything else, kept free of React and storage so it can be tested directly.
 */
import type {
  CaptureSource,
  CastMember,
  Identification,
  MediaKind,
  RecognitionResult,
  ResolvedLink,
  SavedItem,
  SessionHandle,
  SessionStatus,
  VideoPlatform,
  WatchOption,
} from "@tvsham/shared";
import type { QueuedClip } from "./queue";

const KINDS: readonly MediaKind[] = ["movie", "tv_episode", "tv_show", "youtube", "short_form", "other", "unknown"];
const PLATFORMS: readonly VideoPlatform[] = ["youtube", "tiktok", "instagram", "other"];
const PROVIDERS: readonly ResolvedLink["provider"][] = ["wikipedia", "youtube", "tiktok", "instagram", "web"];
const LINK_CONFIDENCE: readonly ResolvedLink["confidence"][] = ["verified", "unverified", "search"];
const STATUSES: readonly SessionStatus[] = ["listening", "identified", "unsure", "failed"];
const WATCH_KINDS: readonly WatchOption["kind"][] = ["stream", "rent", "buy"];
const SOURCES: readonly CaptureSource[] = ["camera", "screen"];

/** Longest string kept from an untrusted payload; the UI truncates long text anyway. */
const MAX_TEXT = 2000;
/** Most items kept from an untrusted network list, so one response cannot fill the device. */
const MAX_ITEMS = 100;

function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : fallback;
}

/** A string worth keeping, or undefined so the optional field stays absent. */
function optionalText(value: unknown): string | undefined {
  const s = text(value);
  return s.length > 0 ? s : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_ITEMS) : [];
}

/**
 * A list the app itself wrote, kept whole. MAX_ITEMS bounds what a server sent;
 * the saved library is bounded by nothing — saving is one tap per
 * identification and no code path prunes it — so applying the response ceiling
 * here would drop the oldest saved items the moment the record is read back,
 * and the next persistLibrary would write that shorter list over the record for
 * good. It would not even bound the work, since JSON.parse has already built
 * the whole array before a slice could shorten it. Stored lists that do have a
 * ceiling apply it where they are written (HISTORY_LIMIT in store.ts,
 * MAX_QUEUED in queue.ts), where the user can see the result.
 */
function storedItems(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function present<T>(value: T | null): value is T {
  return value !== null;
}

/** A whole number in range, or the fallback. NaN and Infinity are neither. */
function counted(value: unknown, max: number, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(0, Math.round(value)))
    : fallback;
}

function year(value: unknown): number | undefined {
  const n = counted(value, 3000, 0);
  return n >= 1800 ? n : undefined;
}

function cleanLink(raw: unknown): ResolvedLink | null {
  const o = fields(raw);
  const url = text(o.url);
  // A link with nowhere to go is not a link. Whether the destination is safe to
  // open is decided at the point of opening it, by isSafeWebUrl.
  if (!url) return null;
  const link: ResolvedLink = {
    provider: oneOf(o.provider, PROVIDERS, "web"),
    url,
    title: text(o.title, url),
    confidence: oneOf(o.confidence, LINK_CONFIDENCE, "unverified"),
  };
  const description = optionalText(o.description);
  if (description) link.description = description;
  const imageUrl = optionalText(o.imageUrl);
  if (imageUrl) link.imageUrl = imageUrl;
  return link;
}

function cleanWatch(raw: unknown): WatchOption | null {
  const o = fields(raw);
  const url = text(o.url);
  const service = text(o.service);
  if (!url || !service) return null;
  const option: WatchOption = { kind: oneOf(o.kind, WATCH_KINDS, "stream"), service, url };
  const logoUrl = optionalText(o.logoUrl);
  if (logoUrl) option.logoUrl = logoUrl;
  return option;
}

function cleanCast(raw: unknown): CastMember | null {
  const o = fields(raw);
  const name = text(o.name);
  if (!name) return null;
  const member: CastMember = { name };
  const character = optionalText(o.character);
  if (character) member.character = character;
  const imageUrl = optionalText(o.imageUrl);
  if (imageUrl) member.imageUrl = imageUrl;
  const url = optionalText(o.url);
  if (url) member.url = url;
  return member;
}

/** An identification, or undefined when there is not one worth showing. */
export function cleanIdentification(raw: unknown): Identification | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const id: Identification = {
    kind: oneOf(o.kind, KINDS, "unknown"),
    title: text(o.title, "Unknown"),
    confidence: typeof o.confidence === "number" && Number.isFinite(o.confidence)
      ? Math.min(1, Math.max(0, o.confidence))
      : 0,
    evidence: text(o.evidence),
  };
  const releaseYear = year(o.year);
  if (releaseYear) id.year = releaseYear;
  const creator = optionalText(o.creator);
  if (creator) id.creator = creator;
  const creatorHandle = optionalText(o.creatorHandle);
  if (creatorHandle) id.creatorHandle = creatorHandle;
  if (typeof o.platform === "string" && (PLATFORMS as readonly string[]).includes(o.platform)) {
    id.platform = o.platform as VideoPlatform;
  }
  const wikipediaTitle = optionalText(o.wikipediaTitle);
  if (wikipediaTitle) id.wikipediaTitle = wikipediaTitle;
  const wikipediaEpisodeTitle = optionalText(o.wikipediaEpisodeTitle);
  if (wikipediaEpisodeTitle) id.wikipediaEpisodeTitle = wikipediaEpisodeTitle;
  const youtubeUrl = optionalText(o.youtubeUrl);
  if (youtubeUrl) id.youtubeUrl = youtubeUrl;
  const videoUrl = optionalText(o.videoUrl);
  if (videoUrl) id.videoUrl = videoUrl;

  const episode = fields(o.episode);
  const season = counted(episode.season, 200, 0);
  const number = counted(episode.number, 5000, 0);
  const episodeTitle = optionalText(episode.title);
  if (season || number || episodeTitle) {
    id.episode = {};
    if (season) id.episode.season = season;
    if (number) id.episode.number = number;
    if (episodeTitle) id.episode.title = episodeTitle;
  }

  const alternatives = items(o.alternatives)
    .map((a) => {
      const alt = fields(a);
      const title = optionalText(alt.title);
      if (!title) return null;
      const altYear = year(alt.year);
      return { title, kind: oneOf(alt.kind, KINDS, "unknown"), ...(altYear ? { year: altYear } : {}) };
    })
    .filter(present);
  if (alternatives.length > 0) id.alternatives = alternatives;
  return id;
}

/**
 * What each half of a session handle may contain. The id is interpolated into
 * the request path and the key is sent as an HTTP header, so both cross a
 * protocol boundary the way a clip key does on the server, and are constrained
 * the way the server constrains that one. The server mints a UUID and a
 * 43-character base64url secret, so this costs a real answer nothing; a value
 * with a newline in it, from a server that is not the one the user thinks, is
 * a thrown TypeError inside fetch rather than an ApiError, which the app reads
 * as a network failure and retries against the same answer for ever.
 */
const SESSION_ID = /^[A-Za-z0-9._~-]{1,200}$/;
const SESSION_KEY = /^[A-Za-z0-9_-]{16,200}$/;

/**
 * A newly created session, or null when what came back cannot be used as one.
 * Both halves have to be there: the id names the session and the key is what
 * authorises every later call to it, so a response missing either is a session
 * the app could not talk to.
 */
export function cleanSessionHandle(raw: unknown): SessionHandle | null {
  const o = fields(raw);
  const sessionId = text(o.sessionId);
  const sessionKey = text(o.sessionKey);
  if (!SESSION_ID.test(sessionId) || !SESSION_KEY.test(sessionKey)) return null;
  return { sessionId, sessionKey };
}

/**
 * A server response the screens can render. `parse` in api.ts casts the JSON it
 * decoded, which is a promise about the type rather than a check of it.
 */
export function cleanRecognitionResult(raw: unknown, fallbackSessionId = ""): RecognitionResult {
  const o = fields(raw);
  const result: RecognitionResult = {
    sessionId: text(o.sessionId, fallbackSessionId),
    // An unreadable answer is not a confident one: "failed" is the fallback
    // that cannot claim a match the server never made.
    status: oneOf(o.status, STATUSES, "failed"),
    secondsAnalysed: counted(o.secondsAnalysed, 24 * 60 * 60),
    links: items(o.links).map(cleanLink).filter(present),
    watch: items(o.watch).map(cleanWatch).filter(present),
    cast: items(o.cast).map(cleanCast).filter(present),
    wantsMore: o.wantsMore === true,
    analysing: o.analysing === true,
    message: text(o.message),
  };
  const identification = cleanIdentification(o.identification);
  if (identification) result.identification = identification;
  return result;
}

/**
 * Saved or recently identified items, dropping any that cannot be shown. This
 * is the app's own list, so the whole of it is kept: only the links inside an
 * item, which arrived in a response, carry the untrusted ceiling.
 */
export function cleanSavedItems(raw: unknown): SavedItem[] {
  return storedItems(raw)
    .map((entry): SavedItem | null => {
      const o = fields(entry);
      const id = text(o.id);
      const identification = cleanIdentification(o.identification);
      // Without an id it cannot be removed or de-duplicated, and without an
      // identification the row has nothing to draw.
      if (!id || !identification) return null;
      return {
        id,
        savedAt: text(o.savedAt),
        source: oneOf(o.source, SOURCES, "camera"),
        identification,
        links: items(o.links).map(cleanLink).filter(present),
        watched: o.watched === true,
      };
    })
    .filter(present);
}

/**
 * A stored library or history record, read back the way hydrate reads it. The
 * app wrote this JSON itself, but an older build wrote some of it and a build
 * the OS killed mid-write wrote the rest, so it is coerced like anything else.
 */
export function readSavedItems(raw: string | null | undefined): SavedItem[] {
  if (!raw) return [];
  try {
    return cleanSavedItems(JSON.parse(raw));
  } catch {
    // A record that is not JSON at all is an empty list, not a failed hydrate.
    return [];
  }
}

/**
 * Clips waiting for a connection. This list is walked unattended on every
 * foreground event, and its entries are handed straight to createSession and
 * uploadClip, so an entry without a file to send is dropped here. The queue is
 * the one stored list with a ceiling of its own (MAX_QUEUED, applied when a
 * clip is queued), so MAX_ITEMS here is a backstop a real record never reaches.
 */
export function cleanQueuedClips(raw: unknown): QueuedClip[] {
  return items(raw)
    .map((entry): QueuedClip | null => {
      const o = fields(entry);
      const id = text(o.id);
      const uri = text(o.uri);
      if (!id || !uri) return null;
      const clip: QueuedClip = {
        id,
        uri,
        source: oneOf(o.source, SOURCES, "camera"),
        queuedAt: text(o.queuedAt),
        reason: text(o.reason),
      };
      const hint = optionalText(o.hint);
      if (hint) clip.hint = hint;
      return clip;
    })
    .filter(present);
}
