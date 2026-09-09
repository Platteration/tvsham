import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  CONFIDENT_THRESHOLD,
  MAX_CLIPS_PER_SESSION,
  MAX_HINT_LENGTH,
  MIN_USEFUL_CONFIDENCE,
  type CaptureSource,
  type CreateSessionResponse,
  type HealthResponse,
  type RecognitionResult,
} from "@tvsham/shared";
import { config } from "./config.js";
import { Limiter } from "./limiter.js";
import { assertDecodable, extractAudio, extractFrames, ffmpegBinary } from "./media.js";
import { recogniseWithEscalation } from "./recognize.js";
import { resolveLinks } from "./resolve.js";
import {
  createSession,
  deleteSession,
  getSession,
  sessionCount,
  sessionsHeldBy,
  sweepSessions,
  type Session,
} from "./sessions.js";
import { enrich } from "./tmdb.js";
import { sttProvider } from "./stt.js";
import { createUsageStore } from "./usage.js";

/** Frames one session may carry into a single recognition request. */
const MAX_EVIDENCE_FRAMES = 24;

const app = new Hono();
const limiter = new Limiter(config.maxConcurrent);
const usage = createUsageStore(config.dailyClipLimit);

/**
 * An IPv6 address as all eight groups, so two spellings of one address compare
 * equal. Null when it is not an IPv6 address at all.
 */
function ipv6Groups(raw: string): string[] | null {
  if (!net.isIPv6(raw)) return null;
  let addr = raw;
  // A trailing dotted quad ("::ffff:203.0.113.5") is two groups, not one.
  const embedded = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (embedded) {
    const o = embedded[1]!.split(".").map(Number);
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = (o[0]! << 8) | o[1]!;
    const lo = (o[2]! << 8) | o[3]!;
    addr = `${addr.slice(0, embedded.index)}:${hi.toString(16)}:${lo.toString(16)}`;
  }
  const parts = addr.split("::");
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0]!.split(":") : [];
  if (parts.length === 1) return left.length === 8 ? left : null;
  const right = parts[1] ? parts[1]!.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array<string>(missing).fill("0"), ...right];
}

/**
 * The bucket an address is counted against. An address cannot be forged, but on
 * IPv6 it is not scarce either: an ordinary client is handed a whole /64 and can
 * source every request from a different address in it, which would give each
 * request a fresh daily quota and a fresh set of session slots. Counting the /64
 * makes an IPv6 client exactly as expensive to rotate as an IPv4 one.
 */
export function addressBucket(address: string): string {
  // An IPv6 zone id ("fe80::1%eth0") is local to the host, not part of identity.
  const bare = (address.split("%")[0] ?? "").trim();
  if (!bare) return "ip:unknown";
  if (net.isIPv4(bare)) return `ip:${bare}`;
  const groups = ipv6Groups(bare);
  if (!groups) return `ip:${bare}`;
  const n = groups.map((g) => parseInt(g, 16));
  // ::ffff:a.b.c.d is an IPv4 client on a dual-stack socket: one address, and
  // billing its /64 would put every IPv4 client in the world in one bucket.
  if (n[5] === 0xffff && n.slice(0, 5).every((g) => g === 0)) {
    return `ip:${n[6]! >> 8}.${n[6]! & 0xff}.${n[7]! >> 8}.${n[7]! & 0xff}`;
  }
  return `ip6:${n.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/**
 * Who to bill a clip to. This has to be something the caller cannot choose, so
 * it is the socket's own address; the app's device id is a label, not identity,
 * and counting it would let anyone reset their quota by editing a header.
 * X-Forwarded-For is only honoured when the operator says a proxy sets it.
 */
export function caller(c: Context): string {
  if (config.trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return addressBucket(forwarded);
  }
  try {
    const remote = getConnInfo(c).remote.address;
    if (remote) return addressBucket(remote);
  } catch {
    // No socket behind this request (a test harness, or a different adapter).
  }
  // Everyone shares one bucket rather than everyone getting their own: an
  // unidentifiable caller should be restricted, never exempt.
  return "ip:unknown";
}
app.use("*", logger());
// The mobile app is not a browser and needs no CORS. Sending permissive headers
// by default would let any web page the user visits spend the operator's budget
// and read back what the household watched, so this is opt-in.
if (config.corsOrigin) app.use("*", cors({ origin: config.corsOrigin }));

function tokenMatches(header: string, expected: string): boolean {
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Optional bearer-token gate for everything except the health check.
app.use("*", async (c, next) => {
  if (!config.appToken || c.req.path === "/health") return next();
  if (tokenMatches(c.req.header("authorization") ?? "", config.appToken)) return next();
  return c.json({ error: "unauthorised" }, 401);
});

// Reject oversized bodies before they are buffered (the content-length check alone
// can be sidestepped with chunked encoding). Every route gets a limit: JSON routes
// buffer their body too, so an unbounded one is just as good a way to exhaust memory.
app.use(
  "/sessions",
  bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: "body too large" }, 413) }),
);
app.use(
  "/sessions/:id/clips",
  bodyLimit({
    maxSize: config.maxUploadBytes,
    onError: (c) => c.json({ error: "clip too large" }, 413),
  }),
);

app.get("/health", async (c) => {
  const body: HealthResponse = {
    ok: true,
    version: config.version,
    ffmpeg: (await ffmpegBinary()) !== null,
    stt: sttProvider().name,
    model: config.model,
    tmdb: Boolean(config.tmdbApiKey),
    dailyClipLimit: config.dailyClipLimit,
    ...(config.firstPassModel ? { firstPassModel: config.firstPassModel } : {}),
  };
  return c.json(body);
});

app.post("/sessions", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { source?: string; hints?: string; region?: string };
  const source: CaptureSource = body.source === "screen" ? "screen" : "camera";
  const owner = caller(c);
  // Sessions are cheap to make and only freed by the sweep, and getSession
  // refreshes touchedAt on every read, so one caller polling its own sessions
  // could hold every slot for ever and deny the service to everyone else.
  // Sweeping first means a refusal really means "in use", not "never tidied".
  if (sessionCount() >= config.maxSessions || sessionsHeldBy(owner) >= config.maxSessionsPerCaller) {
    sweepSessions();
    if (sessionCount() >= config.maxSessions) return c.json({ error: "server busy, try again shortly" }, 503);
    if (sessionsHeldBy(owner) >= config.maxSessionsPerCaller) {
      c.header("Retry-After", "60");
      return c.json({ error: "too many open sessions from this address" }, 503);
    }
  }
  const s = createSession(source, cleanHint(body.hints), cleanRegion(body.region), owner);
  const res: CreateSessionResponse = { sessionId: s.id };
  return c.json(res, 201);
});

app.get("/sessions/:id", (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "no such session" }, 404);
  return c.json(describe(s));
});

app.delete("/sessions/:id", (c) => {
  deleteSession(c.req.param("id"));
  return c.body(null, 204);
});

/**
 * Upload one clip. Multipart form with a `clip` file field (mp4 / mov / webm).
 * The response reflects *all* clips in the session so far.
 */
app.post("/sessions/:id/clips", async (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "no such session" }, 404);
  if (s.clips >= MAX_CLIPS_PER_SESSION) {
    return c.json({ ...describe(s), wantsMore: false, message: "Clip limit reached for this session." });
  }
  // The clip key arrives as a header as well as a form field, so a retry can be
  // recognised before its 80 MB body is buffered.
  const headerKey = cleanClipKey(c.req.header("x-clip-key"));
  if (headerKey && s.seenClipKeys.has(headerKey)) {
    // The key is recorded before recognition finishes, so wait for the original
    // to settle: otherwise a retry gets the half-written "still listening" state
    // and the app stores that as the answer. Bounded, because s.busy is the tail
    // of the whole session's queue and this path exists to answer quickly.
    const settled = await settledWithin(s.busy, config.retryWaitMs);
    if (settled) return c.json(describe(s));
    // Still working. 202 says so explicitly, so the caller polls GET /sessions/:id
    // rather than mistaking a mid-flight state for the final answer.
    c.header("Retry-After", "5");
    return c.json({ ...describe(s), message: "Still analysing this clip." }, 202);
  }
  // Read now, while the socket is still open: the work below runs after a queue
  // wait, by which time a disconnected client has no address to bill.
  const billTo = caller(c);
  // An over-quota caller should not get to make us buffer the body at all. The
  // quota itself is only spent further down, once the clip is really analysed.
  if (usage.remaining(billTo) <= 0) return overLimit(c, s);
  const form = await c.req.parseBody();
  const clip = form["clip"];
  if (!(clip instanceof File)) return c.json({ error: "missing `clip` file field" }, 400);
  if (clip.size > config.maxUploadBytes) return c.json({ error: "clip too large" }, 413);
  if (clip.size < 1024) return c.json({ error: "clip is empty" }, 400);
  const clipKey = headerKey ?? cleanClipKey(form["clipKey"]);

  // Serialise per session (a second upload waits for the first) and cap global
  // concurrency. The duplicate check, the clip cap and the quota are all settled
  // here rather than at request entry: s.clips only moves inside processClip, so
  // concurrent uploads would otherwise all pass an entry check and run together,
  // and a clip turned away here must not have spent a daily unit.
  const work: Promise<Outcome> = s.busy.then(() => {
    if (clipKey && s.seenClipKeys.has(clipKey)) return { result: describe(s) };
    if (s.clips >= MAX_CLIPS_PER_SESSION) {
      return { result: { ...describe(s), wantsMore: false, message: "Clip limit reached for this session." } };
    }
    if (!usage.take(billTo)) return { result: overLimitResult(s), status: 429 as const };
    s.analysing++;
    return limiter.run(async () => {
      try {
        await processClip(s, clip, clipKey);
      } finally {
        // Decremented before the response is built, or this clip's own answer
        // would claim the session is still analysing.
        s.analysing--;
      }
      return { result: describe(s) };
    });
  });
  s.busy = work.catch(() => undefined);
  try {
    const outcome = await work;
    return c.json(outcome.result, outcome.status ?? 200);
  } catch (err) {
    console.error("[clip]", err);
    return c.json({ ...describe(s), status: "failed", wantsMore: false, message: clientErrorMessage(err) }, 500);
  }
});

async function processClip(s: Session, clip: File, clipKey?: string): Promise<void> {
  const workDir = path.join(config.tmpDir, `${s.id}-${s.clips}`);
  await fs.mkdir(workDir, { recursive: true });
  const ext = safeExtension(clip.name);
  const clipPath = path.join(workDir, `clip${ext}`);
  try {
    await fs.writeFile(clipPath, Buffer.from(await clip.arrayBuffer()));
    // Refuse absurd dimensions or lengths before decoding anything from them.
    const { seconds: duration } = await assertDecodable(clipPath);
    const looked = Math.min(duration || config.maxClipSeconds, config.maxClipSeconds);
    // Longer uploads (a shared screen recording) get more frames than an 8 s camera clip.
    const frameCount = Math.min(12, Math.max(config.framesPerClip, Math.round(looked / 4)));

    const [frames, wav] = await Promise.all([
      // The duration is already known from assertDecodable, so this does not re-probe.
      extractFrames(clipPath, {
        count: frameCount,
        maxSeconds: config.maxClipSeconds,
        workDir,
        spanSeconds: duration,
      }),
      extractAudio(clipPath, { maxSeconds: config.maxClipSeconds, workDir }),
    ]);
    const transcript = wav ? await sttProvider().transcribe(wav) : null;

    const clipIndex = s.clips;
    s.clips += 1;
    if (clipKey) s.seenClipKeys.add(clipKey);
    s.secondsAnalysed += looked;
    s.evidence.frames.push(...frames.map((f) => ({ ...f, clip: clipIndex })));
    s.evidence.transcripts.push(transcript ?? "");
    // Every clip re-sends the whole session's evidence, so without a ceiling the
    // images in one request grow with each clip and the token cost grows with
    // the square of them. Keep the most recent frames; they are the freshest view.
    if (s.evidence.frames.length > MAX_EVIDENCE_FRAMES) {
      s.evidence.frames = s.evidence.frames.slice(-MAX_EVIDENCE_FRAMES);
    }

    const identification = await recogniseWithEscalation(s.evidence);
    const [links, extra] = await Promise.all([
      resolveLinks(identification),
      enrich(identification, s.region),
    ]);
    s.last = { identification, links, ...extra };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/** What the per-session work chain resolves to: a body, and the status to send it with. */
interface Outcome {
  result: RecognitionResult;
  status?: 429;
}

function overLimitResult(s: Session): RecognitionResult {
  return {
    ...describe(s),
    status: "failed",
    wantsMore: false,
    message: `Daily limit of ${config.dailyClipLimit} clips reached. It resets tomorrow.`,
  };
}

function overLimit(c: Context, s: Session) {
  return c.json(overLimitResult(s), 429);
}

/**
 * Whether `work` finished inside `ms`. The timer is always cleared: an
 * uncancelled one would outlive every request that settled on the first tick.
 */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    // Deliberately not unref'd: an unref'd timer never fires when nothing else
    // holds the event loop open, and the finally below always clears it, so it
    // cannot keep the process alive either.
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Clip keys come from the client, and are only ever compared, never interpolated. */
export function cleanClipKey(raw: unknown): string | undefined {
  return typeof raw === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(raw) ? raw : undefined;
}

function describe(s: Session): RecognitionResult {
  const base = {
    sessionId: s.id,
    secondsAnalysed: Math.round(s.secondsAnalysed),
    watch: s.last?.watch ?? [],
    cast: s.last?.cast ?? [],
    analysing: s.analysing > 0,
  };
  if (!s.last) {
    return {
      ...base,
      status: "listening",
      links: [],
      wantsMore: true,
      message: "Listening… keep the screen in view.",
    };
  }
  const { identification, links } = s.last;
  const conf = identification.confidence;
  const canContinue = s.clips < MAX_CLIPS_PER_SESSION;
  if (conf >= CONFIDENT_THRESHOLD && identification.kind !== "unknown") {
    return {
      ...base,
      status: "identified",
      identification,
      links,
      wantsMore: false,
      message: "Found it.",
    };
  }
  if (conf >= MIN_USEFUL_CONFIDENCE && identification.kind !== "unknown") {
    return {
      ...base,
      status: canContinue ? "listening" : "unsure",
      identification,
      links,
      wantsMore: canContinue,
      message: canContinue
        ? `Might be ${identification.title}… keep going for a better match.`
        : `Best guess: ${identification.title}.`,
    };
  }
  return {
    ...base,
    status: canContinue ? "listening" : "failed",
    identification,
    links,
    wantsMore: canContinue,
    message: canContinue
      ? "Not sure yet. Try to get dialogue or on-screen text in the shot."
      : "Couldn't identify this. Try again with a clearer view or a longer clip.",
  };
}

/** A two-letter country code, or undefined so the server default applies. */
export function cleanRegion(raw: unknown): string | undefined {
  return typeof raw === "string" && /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : undefined;
}

/** The user's optional hint: collapsed to one short single line before it reaches the model. */
export function cleanHint(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const hint = raw.replace(/\s+/g, " ").trim().slice(0, MAX_HINT_LENGTH);
  return hint.length > 0 ? hint : undefined;
}

const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".3gp"]);

/** Only a known video extension from the upload name is used; anything else becomes .mp4. */
export function safeExtension(name: string | undefined): string {
  const ext = path.extname(name ?? "").toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext) ? ext : ".mp4";
}

/**
 * Internal error details stay in the server log. They are only echoed to the
 * client when NODE_ENV explicitly says development: an unset NODE_ENV is the
 * common case when running `npm run server`, and it should not leak paths or
 * upstream API error bodies.
 */
function clientErrorMessage(err: unknown): string {
  if (process.env.NODE_ENV !== "development") return "Recognition failed on the server. Check the server logs.";
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  await fs.mkdir(config.tmpDir, { recursive: true });
  setInterval(() => sweepSessions(), 60_000).unref();
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("[server] ANTHROPIC_API_KEY is not set; recognition requests will fail until it is.");
  }
  if (!config.appToken) {
    console.warn("[server] APP_TOKEN is not set: anyone who can reach this port can spend your API budget. Set it for anything beyond a private LAN.");
  }
  console.log(`[server] ffmpeg: ${(await ffmpegBinary()) ?? "NOT FOUND"}`);
  console.log(`[server] model: ${config.model}, stt: ${sttProvider().name}`);
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[server] listening on http://0.0.0.0:${info.port}`);
  });
}

export { app };

// Only start listening when run directly (tests import `app`).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("src", "index.ts")) ||
    process.argv[1]?.endsWith(path.join("dist", "index.js"))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
