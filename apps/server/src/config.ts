import path from "node:path";
import { UPLOAD_DEADLINE_MS } from "@tvsham/shared";

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

/** TRUST_PROXY is a count of proxies; `true` is the old spelling of "one". */
function proxyHops(raw: string | undefined): number {
  if (raw === "true") return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Read once so the in-flight ceiling below can be derived from it. */
const maxConcurrent = positiveInt(env("MAX_CONCURRENT"), 3);

/** ...and once more so the per-caller share of it can be. */
const maxUploadsInFlight = positiveInt(env("MAX_UPLOADS_IN_FLIGHT"), maxConcurrent * 2);

/**
 * ...and again, because node refuses to start if the headers wait is the longer
 * one. The default is the app's own upload deadline plus the 30 s granularity
 * of node's expiry check and a little slack: the client must be the one that
 * gives up first, or a slow upload is cut off mid-body and the app sees a
 * transport failure rather than an answer.
 */
const requestTimeoutMs = positiveInt(env("REQUEST_TIMEOUT_MS"), UPLOAD_DEADLINE_MS + 60_000);

export const config = {
  port: Number(env("PORT", "8787")),
  /**
   * Interface to listen on. Loopback by default, which is what the README's
   * quickstart says the address is: the server is unauthenticated and uncapped
   * out of the box, and `npm run server` on a laptop otherwise puts it on every
   * café and hotel network the laptop joins. Set HOST=0.0.0.0 to let a phone
   * on your LAN reach it — after APP_TOKEN. The Docker image sets it, because
   * there the published port is the boundary and compose keeps that on
   * loopback.
   */
  host: env("HOST", "127.0.0.1")!,
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
   * Streams one upload may declare. ffmpeg opens a decoder for every stream in
   * the file while probing it, so a container holding sixty copies of a
   * within-budget video costs sixty decoders' memory — and the pixel budget
   * above, which measures one stream, never sees it. A phone records a video
   * and an audio track, plus a timecode and a metadata track or two.
   */
  maxStreams: positiveInt(env("MAX_STREAMS"), 8),
  /**
   * How much of an upload ffmpeg may read while working out what is in it.
   *
   * The budgets above are checked against what the probe *reports*, so they
   * cannot bound what the probe itself takes to find out: ffmpeg decodes frames
   * from every stream to fill in what the container did not declare, and eight
   * streams claiming 8192x4608 cost 736 MB to refuse. Reading a fixed short
   * prefix instead costs 113 MB for that file and nothing measurable for a real
   * clip, because the dimensions, stream count and duration are all in the
   * container's own header. Not an environment variable: this is the only thing
   * standing between a 1.4 MB upload and the container's memory limit, and
   * there is no operator reason to raise it.
   */
  probeBytes: 100_000,
  /**
   * Address space one probe may take, in MB; 0 turns it off. A second line
   * behind probeBytes rather than the bound itself: if a future ffmpeg, or a
   * format nobody here tested, allocates before it honours a probe size, the
   * child dies instead of the container. A probe of a real clip measures about
   * 130 MB of address space and the worst refused one about 200 MB, so this is
   * several times what any legitimate clip needs — but it is a hard ceiling on
   * a machine whose allocator reserves more, so an operator who sees every clip
   * refused as unreadable has this to raise or turn off.
   */
  probeMemoryMb: nonNegativeInt(env("PROBE_MEMORY_MB"), 512),
  /**
   * How many proxies of your own stand in front of this server. Only set it
   * when they really are yours: X-Forwarded-For is otherwise just a string the
   * caller chooses, and the daily cap would count nothing.
   *
   * A count rather than a flag, because every standard proxy *appends* the
   * address it saw to whatever the client already sent. The client's own value
   * is therefore on the left and the address the outermost proxy of yours
   * observed is this many entries from the right; without knowing how many
   * that is there is no way to tell one from the other. `TRUST_PROXY=true`
   * still means one proxy, which is what it always meant to say.
   */
  trustedProxyHops: proxyHops(env("TRUST_PROXY")),
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
  maxUploadsInFlight,
  /**
   * ...of which one caller may hold this many. A body is only released when it
   * has all arrived, so a client that dribbles one byte every few seconds holds
   * a slot for as long as it likes for no cost at all; without a share per
   * caller, a handful of sockets from one address answers every real upload
   * with a 503. Half the slots, so one address can never take them all.
   */
  maxUploadsPerCaller: positiveInt(env("MAX_UPLOADS_PER_CALLER"), Math.max(1, Math.ceil(maxUploadsInFlight / 2))),
  /**
   * Longest the server will wait for a whole request to arrive, and for its
   * headers. Node's own defaults are 5 minutes and 1 minute, which is how long
   * a stalled upload holds its slot. Shortening that is what MAX_UPLOADS_IN_FLIGHT
   * and MAX_UPLOADS_PER_CALLER are really for, so this only has to be longer
   * than the app will wait: 80 MB is a whole screen recording, and 80 MB in
   * 120 s is a sustained 5.3 Mbit/s uplink, which is an ordinary mobile
   * connection rather than a stalled one. Cutting it off there is silent and
   * self-perpetuating — the app reads a dropped body as a network failure,
   * queues the clip, and every retry meets the same wall. Node checks for
   * expiry on its own 30 s interval, so the real cut-off is this plus up to
   * half a minute.
   */
  requestTimeoutMs,
  headersTimeoutMs: Math.min(positiveInt(env("HEADERS_TIMEOUT_MS"), 15_000), requestTimeoutMs),
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
