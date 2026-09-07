import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
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
import { extractAudio, extractFrames, ffmpegBinary, probeDuration } from "./media.js";
import { recogniseWithEscalation } from "./recognize.js";
import { resolveLinks } from "./resolve.js";
import { createSession, deleteSession, getSession, sweepSessions, type Session } from "./sessions.js";
import { enrich } from "./tmdb.js";
import { sttProvider } from "./stt.js";
import { createUsageStore } from "./usage.js";

const app = new Hono();
const limiter = new Limiter(config.maxConcurrent);
const usage = createUsageStore(config.dailyClipLimit);

/** Who to bill a clip to: the device id the app sends, else the peer address. */
function caller(c: Context): string {
  const device = c.req.header("x-device-id");
  if (device && /^[A-Za-z0-9_-]{8,64}$/.test(device)) return `d:${device}`;
  return `ip:${c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"}`;
}
app.use("*", logger());
app.use("*", cors());

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
// can be sidestepped with chunked encoding).
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
  const s = createSession(source, cleanHint(body.hints), cleanRegion(body.region));
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
  const form = await c.req.parseBody();
  const clip = form["clip"];
  if (!(clip instanceof File)) return c.json({ error: "missing `clip` file field" }, 400);
  if (clip.size > config.maxUploadBytes) return c.json({ error: "clip too large" }, 413);
  if (clip.size < 1024) return c.json({ error: "clip is empty" }, 400);
  const clipKey = typeof form["clipKey"] === "string" ? form["clipKey"] : undefined;
  const alreadySeen = clipKey !== undefined && s.seenClipKeys.has(clipKey);
  // A retry of a clip we already analysed costs nothing, so it does not count.
  if (!alreadySeen && !usage.take(caller(c))) {
    return c.json(
      {
        ...describe(s),
        status: "failed",
        wantsMore: false,
        message: `Daily limit of ${config.dailyClipLimit} clips reached. It resets tomorrow.`,
      },
      429,
    );
  }

  // Serialise per session (a second upload waits for the first) and cap global concurrency.
  // A retried upload with a key we have already analysed just returns the current answer.
  const work = s.busy.then(() => {
    if (clipKey && s.seenClipKeys.has(clipKey)) return describe(s);
    return limiter.run(() => processClip(s, clip, clipKey));
  });
  s.busy = work.catch(() => undefined);
  try {
    return c.json(await work);
  } catch (err) {
    console.error("[clip]", err);
    return c.json({ ...describe(s), status: "failed", wantsMore: false, message: clientErrorMessage(err) }, 500);
  }
});

async function processClip(s: Session, clip: File, clipKey?: string): Promise<RecognitionResult> {
  const workDir = path.join(config.tmpDir, `${s.id}-${s.clips}`);
  await fs.mkdir(workDir, { recursive: true });
  const ext = safeExtension(clip.name);
  const clipPath = path.join(workDir, `clip${ext}`);
  try {
    await fs.writeFile(clipPath, Buffer.from(await clip.arrayBuffer()));
    const duration = await probeDuration(clipPath);
    const looked = Math.min(duration || config.maxClipSeconds, config.maxClipSeconds);
    // Longer uploads (a shared screen recording) get more frames than an 8 s camera clip.
    const frameCount = Math.min(12, Math.max(config.framesPerClip, Math.round(looked / 4)));

    const [frames, wav] = await Promise.all([
      extractFrames(clipPath, { count: frameCount, maxSeconds: config.maxClipSeconds, workDir }),
      extractAudio(clipPath, { maxSeconds: config.maxClipSeconds, workDir }),
    ]);
    const transcript = wav ? await sttProvider().transcribe(wav) : null;

    const clipIndex = s.clips;
    s.clips += 1;
    if (clipKey) s.seenClipKeys.add(clipKey);
    s.secondsAnalysed += looked;
    s.evidence.frames.push(...frames.map((f) => ({ ...f, clip: clipIndex })));
    s.evidence.transcripts.push(transcript ?? "");

    const identification = await recogniseWithEscalation(s.evidence);
    const [links, extra] = await Promise.all([
      resolveLinks(identification),
      enrich(identification, s.region),
    ]);
    s.last = { identification, links, ...extra };
    return describe(s);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

function describe(s: Session): RecognitionResult {
  const base = {
    sessionId: s.id,
    secondsAnalysed: Math.round(s.secondsAnalysed),
    watch: s.last?.watch ?? [],
    cast: s.last?.cast ?? [],
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

/** Internal error details stay in the server log; clients get a generic message in production. */
function clientErrorMessage(err: unknown): string {
  if (process.env.NODE_ENV === "production") return "Recognition failed on the server. Check the server logs.";
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
