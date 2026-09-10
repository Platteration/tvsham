import path from "node:path";

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** Like positiveInt, but 0 is a meaningful value ("off") rather than a typo. */
function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Read once so the in-flight ceiling below can be derived from it. */
const maxConcurrent = positiveInt(env("MAX_CONCURRENT"), 3);

export const config = {
  port: Number(env("PORT", "8787")),
  appToken: env("APP_TOKEN"),
  model: env("CLAUDE_MODEL", "claude-opus-5")!,
  /**
   * Optional cheaper model for a first pass. When it comes back unsure the same
   * evidence is re-run on the main model, so only hard clips pay full price.
   * Opt-in: measure accuracy on your own clips before turning it on.
   */
  firstPassModel: env("FIRST_PASS_MODEL"),
  tmpDir: path.resolve(env("TMP_DIR", "./tmp")!),
  ffmpegPath: env("FFMPEG_PATH"),
  stt: {
    provider: env("STT_PROVIDER", "none")! as "none" | "whisper-http",
    /**
     * Where audio is sent for transcription. No default on purpose: this server
     * is self-hosted, and a default of somebody's hosted API would mean turning
     * dialogue on quietly shipped a minute of the operator's living room to a
     * third party they never chose. Required when the provider is whisper-http.
     */
    url: env("STT_URL"),
    apiKey: env("STT_API_KEY"),
    model: env("STT_MODEL", "whisper-1")!,
    /** Deadline for one transcription. Transcribing a minute of audio is slow; hanging is worse. */
    timeoutMs: positiveInt(env("STT_TIMEOUT_MS"), 60_000),
  },
  youtubeApiKey: env("YOUTUBE_API_KEY"),
  /** Optional TMDB v3 key: adds "where to watch" and a cast list. */
  tmdbApiKey: env("TMDB_API_KEY"),
  /** Country used for watch providers when the app does not send one. */
  defaultRegion: env("WATCH_REGION", "US")!,
  /** Wikipedia edition used for article lookups. */
  wikipediaLang: env("WIKIPEDIA_LANG", "en")!,
  /** Frames sampled per clip. */
  framesPerClip: 6,
  /** Longest slice of a single upload we look at, in seconds. */
  maxClipSeconds: 60,
  /** Max upload size in bytes. */
  maxUploadBytes: 80 * 1024 * 1024,
  /** Hard limit on any single ffmpeg invocation. Decoding is attacker-driven work. */
  ffmpegTimeoutMs: positiveInt(env("FFMPEG_TIMEOUT_MS"), 20_000),
  /**
   * Largest frame we will decode, in pixels. A 424 KB file can declare a
   * 16000x9000 video, which costs gigabytes of memory to decode a frame from.
   */
  maxPixels: positiveInt(env("MAX_PIXELS"), 4096 * 2304),
  /** Longest input we will accept, whatever the container claims. */
  maxDurationSeconds: positiveInt(env("MAX_DURATION_SECONDS"), 15 * 60),
  /**
   * Trust X-Forwarded-For for the caller's address. Only turn this on when the
   * server really is behind a proxy you control: the header is otherwise just a
   * string the caller chooses, and the daily cap would count nothing.
   */
  trustProxy: env("TRUST_PROXY") === "true",
  /** Allowed browser origin. Empty (the default) sends no CORS headers at all. */
  corsOrigin: env("CORS_ORIGIN"),
  /** Live sessions to keep before refusing new ones. */
  maxSessions: positiveInt(env("MAX_SESSIONS"), 500),
  /**
   * Live sessions one caller may hold at once. Creating a session is free and
   * unauthenticated, so without this one address can take every slot in the
   * table and the server answers 503 for everyone else.
   */
  maxSessionsPerCaller: positiveInt(env("MAX_SESSIONS_PER_CALLER"), 20),
  /** Clips one device may have analysed per day. 0 turns the cap off. */
  dailyClipLimit: Math.max(0, Math.floor(Number(env("DAILY_CLIP_LIMIT", "0")) || 0)),
  /** How many clips may be analysed at once; the rest queue. Protects the API budget. */
  maxConcurrent,
  /**
   * Uploads that may be resident at once, counted before the body is read.
   * Each one costs about twice maxUploadBytes in memory while it is in flight,
   * and analysis is the slow part, so this is the queue in front of
   * maxConcurrent — and the reason a burst answers 503 instead of exhausting
   * the heap. Raise it only alongside the memory the process actually has.
   */
  maxUploadsInFlight: positiveInt(env("MAX_UPLOADS_IN_FLIGHT"), maxConcurrent * 2),
  /** Longest a retried clip waits for the original analysis before answering. */
  retryWaitMs: nonNegativeInt(env("RETRY_WAIT_MS"), 45_000),
  /** Sessions idle longer than this are dropped. */
  sessionTtlMs: 15 * 60 * 1000,
  /**
   * ...and no session lives longer than this whatever it does. Reading a session
   * refreshes its idle clock, so the idle timeout on its own is not a lifetime.
   */
  sessionMaxAgeMs: positiveInt(env("SESSION_MAX_AGE_MS"), 60 * 60 * 1000),
  version: "0.1.0",
} as const;
