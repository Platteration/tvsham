/**
 * Types shared between the TVsham mobile app and the recognition server.
 * The server is the source of truth for these shapes; the app only renders them.
 */

/** Where the clip came from. */
export type CaptureSource = "camera" | "screen";

/** What kind of thing was identified. */
export type MediaKind =
  | "movie"
  | "tv_episode"
  | "tv_show"
  | "youtube"
  | "short_form"
  | "other"
  | "unknown";

/** Platforms a short video can live on. */
export type VideoPlatform = "youtube" | "tiktok" | "instagram" | "other";

/** A link the user can open or save. */
export interface ResolvedLink {
  /** Where the link points. */
  provider: "wikipedia" | "youtube" | "tiktok" | "instagram" | "web";
  url: string;
  title: string;
  /** Short blurb (Wikipedia extract, YouTube channel name, ...). */
  description?: string;
  /** Poster / thumbnail if we found one. */
  imageUrl?: string;
  /**
   * `verified` means we confirmed the page or video exists (Wikipedia summary,
   * YouTube oEmbed). `search` means it is a search-results URL fallback.
   */
  confidence: "verified" | "unverified" | "search";
}

export interface Identification {
  kind: MediaKind;
  /** Human title: "Breaking Bad", "Inception", "MrBeast – I Spent 50 Hours Buried Alive". */
  title: string;
  /** Release year for movies / first-air year for shows, if known. */
  year?: number;
  /** Episode details when kind === "tv_episode". */
  episode?: {
    season?: number;
    number?: number;
    title?: string;
  };
  /** Channel / creator for youtube and short_form. */
  creator?: string;
  /** The creator's @handle, without the @. */
  creatorHandle?: string;
  /** Which app the short video is from, so we link to the right one. */
  platform?: VideoPlatform;
  /** 0..1 – how sure the recogniser is. */
  confidence: number;
  /** One or two sentences: what evidence led to this answer. */
  evidence: string;
  /** Wikipedia article title the model believes matches (pre-verification). */
  wikipediaTitle?: string;
  /** Wikipedia title for the episode article if one exists. */
  wikipediaEpisodeTitle?: string;
  /** Direct YouTube URL if the model found one. */
  youtubeUrl?: string;
  /** Direct URL on the video's own platform (TikTok, Instagram, ...). */
  videoUrl?: string;
  /** Alternative candidates, best first, when confidence is low. */
  alternatives?: Array<{ title: string; kind: MediaKind; year?: number }>;
}

/** One way to watch the thing that was identified, in the user's country. */
export interface WatchOption {
  kind: "stream" | "rent" | "buy";
  /** "Netflix", "Prime Video", ... */
  service: string;
  logoUrl?: string;
  /** Where to go to start watching. */
  url: string;
}

/** A person on screen. */
export interface CastMember {
  name: string;
  character?: string;
  imageUrl?: string;
  /** Their page, when we have one. */
  url?: string;
}

export type SessionStatus = "listening" | "identified" | "unsure" | "failed";

export interface RecognitionResult {
  sessionId: string;
  status: SessionStatus;
  /** Seconds of media analysed so far across all clips in the session. */
  secondsAnalysed: number;
  identification?: Identification;
  links: ResolvedLink[];
  /** Streaming, rental and purchase options in the requested region. Empty when unknown. */
  watch: WatchOption[];
  /** Top billed cast, when we could look it up. */
  cast: CastMember[];
  /** True when the server would like another clip to raise confidence. */
  wantsMore: boolean;
  /** True while a clip in this session is still being analysed. */
  analysing: boolean;
  /** Human-readable hint for the UI ("Keep pointing at the screen…"). */
  message: string;
}

/** Longest hint the app will send with a session. */
export const MAX_HINT_LENGTH = 120;

export interface CreateSessionResponse {
  sessionId: string;
}

export interface HealthResponse {
  ok: true;
  version: string;
  ffmpeg: boolean;
  stt: string;
  model: string;
  /** Whether where-to-watch and cast lookups are configured. */
  tmdb: boolean;
  /** Clips one device may analyse per day; 0 means no cap. */
  dailyClipLimit: number;
  /** Cheaper model used for a first pass, when one is configured. */
  firstPassModel?: string;
}

/** An item the user saved for later, stored on the device. */
export interface SavedItem {
  id: string;
  savedAt: string;
  source: CaptureSource;
  identification: Identification;
  links: ResolvedLink[];
  watched: boolean;
}

/** Confidence at or above this is treated as a solid match. */
export const CONFIDENT_THRESHOLD = 0.7;
/** Below this we tell the user we could not identify it. */
export const MIN_USEFUL_CONFIDENCE = 0.35;
/** Length of each clip the app records before uploading, in seconds. */
export const CLIP_SECONDS = 8;
/** Maximum clips per session before giving up. */
export const MAX_CLIPS_PER_SESSION = 4;
