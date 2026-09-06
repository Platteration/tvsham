import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CONFIDENT_THRESHOLD,
  MAX_CLIPS_PER_SESSION,
  MIN_USEFUL_CONFIDENCE,
  type CaptureSource,
  type CreateSessionResponse,
  type HealthResponse,
  type RecognitionResult,
} from "@tvsham/shared";
import { config } from "./config.js";
import { Limiter } from "./limiter.js";
import { extractAudio, extractFrames, ffmpegBinary, probeDuration } from "./media.js";
import { recognise } from "./recognize.js";
import { resolveLinks } from "./resolve.js";
import { createSession, deleteSession, getSession, sweepSessions, type Session } from "./sessions.js";
import { sttProvider } from "./stt.js";

const app = new Hono();
const limiter = new Limiter(config.maxConcurrent);
app.use("*", logger());
app.use("*", cors());

// Optional bearer-token gate for everything except the health check.
app.use("*", async (c, next) => {
  if (!config.appToken || c.req.path === "/health") return next();
  const auth = c.req.header("authorization") ?? "";
  if (auth === `Bearer ${config.appToken}`) return next();
  return c.json({ error: "unauthorised" }, 401);
});

app.get("/health", async (c) => {
  const body: HealthResponse = {
    ok: true,
    version: config.version,
    ffmpeg: (await ffmpegBinary()) !== null,
    stt: sttProvider().name,
    model: config.model,
  };
  return c.json(body);
});

app.post("/sessions", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { source?: string; hints?: string };
  const source: CaptureSource = body.source === "screen" ? "screen" : "camera";
  const s = createSession(source, body.hints);
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
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > config.maxUploadBytes) return c.json({ error: "clip too large" }, 413);

  const form = await c.req.parseBody();
  const clip = form["clip"];
  if (!(clip instanceof File)) return c.json({ error: "missing `clip` file field" }, 400);
  if (clip.size > config.maxUploadBytes) return c.json({ error: "clip too large" }, 413);
  if (clip.size < 1024) return c.json({ error: "clip is empty" }, 400);
  const clipKey = typeof form["clipKey"] === "string" ? form["clipKey"] : undefined;

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
    return c.json({ ...describe(s), status: "failed", wantsMore: false, message: errorMessage(err) }, 500);
  }
});

async function processClip(s: Session, clip: File, clipKey?: string): Promise<RecognitionResult> {
  const workDir = path.join(config.tmpDir, `${s.id}-${s.clips}`);
  await fs.mkdir(workDir, { recursive: true });
  const ext = path.extname(clip.name || "").toLowerCase() || ".mp4";
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

    const identification = await recognise(s.evidence);
    const links = await resolveLinks(identification);
    s.last = { identification, links };
    return describe(s);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

function describe(s: Session): RecognitionResult {
  const base = { sessionId: s.id, secondsAnalysed: Math.round(s.secondsAnalysed) };
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  await fs.mkdir(config.tmpDir, { recursive: true });
  setInterval(() => sweepSessions(), 60_000).unref();
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("[server] ANTHROPIC_API_KEY is not set; recognition requests will fail until it is.");
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
