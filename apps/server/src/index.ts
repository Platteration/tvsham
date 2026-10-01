import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context, type Next } from "hono";
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
import { sttProvider, sttWarning } from "./stt.js";
import { createUsageStore } from "./usage.js";

/** Frames one session may carry into a single recognition request. */
const MAX_EVIDENCE_FRAMES = 24;

/**
 * What the clip gate decided, handed to the route it admits so the route does
 * not have to look any of it up a second time.
 */
interface ClipAdmission {
  session: Session;
  billTo: string;
  clipKey?: string;
}
type AppEnv = { Variables: { clip: ClipAdmission } };

const app = new Hono<AppEnv>();
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
 * The address inside a forwarded hop, with whatever the proxy wrapped around it
 * taken off.
 *
 * Several real proxies write a port: Azure's App Service and Application
 * Gateway append `203.0.113.9:54321`, and an IPv6 hop with a port has to be
 * bracketed (`[2001:db8::1]:443`). `net.isIP` takes neither, so treating them
 * as garbage puts every client behind such a proxy into the one shared
 * `ip:unknown` bucket — which is the "one caller exhausts the cap for
 * everybody" failure the README warns about, in the configuration the README
 * recommends. A bare IPv6 address is all colons and must survive untouched, so
 * the port is only taken off a hop that has exactly one colon in it.
 */
function bareAddress(raw: string): string {
  const hop = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(hop);
  if (bracketed) return bracketed[1]!;
  const withPort = /^([^:]+):\d{1,5}$/.exec(hop);
  if (withPort) return withPort[1]!;
  return hop;
}

/** Said once per process: a trusted hop nobody can read is a configuration fault. */
let warnedUnreadableHop = false;

/**
 * The bucket an address is counted against. An address cannot be forged, but on
 * IPv6 it is not scarce either: an ordinary client is handed a whole /64 and can
 * source every request from a different address in it, which would give each
 * request a fresh daily quota and a fresh set of session slots. Counting the /64
 * makes an IPv6 client exactly as expensive to rotate as an IPv4 one.
 */
export function addressBucket(address: string): string {
  // An IPv6 zone id ("fe80::1%eth0") is local to the host, not part of identity.
  const bare = (bareAddress(address).split("%")[0] ?? "").trim();
  if (!bare) return "ip:unknown";
  // Anything that is not an address is not an identity: a header carrying
  // "aaaa" would otherwise mint the bucket ip:aaaa, and a fresh one per
  // request. An unidentifiable caller shares the restricted bucket instead.
  if (!net.isIP(bare)) return "ip:unknown";
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
  const hops = config.trustedProxyHops;
  if (hops > 0) {
    const chain = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    // Counted from the right. Every standard proxy appends the address it saw
    // to whatever the client already sent, so the leftmost entry is the one
    // the caller typed — reading that bills a bucket of their choosing, and a
    // different one on every request. The entry `hops` from the right is the
    // one the outermost proxy of ours wrote, which they cannot reach. A chain
    // shorter than that did not come through those proxies at all, so it is
    // not an identity either and the socket address below is used instead.
    const written = chain.length >= hops ? chain[chain.length - hops] : undefined;
    if (written) {
      const bucket = addressBucket(written);
      // Failing closed here is right — a hop nobody can parse is not an
      // identity — but it is also every caller in one bucket, and the operator
      // has no way to tell that from their own cap being hit. So say it, once.
      if (bucket === "ip:unknown" && !warnedUnreadableHop) {
        warnedUnreadableHop = true;
        console.warn(
          `[server] TRUST_PROXY is set but the forwarded hop is not an address ("${written.replace(/[^\x20-\x7e]/g, "?").slice(0, 60)}"): ` +
            "every caller is being counted in one shared bucket. Check how many proxies you really run.",
        );
      }
      return bucket;
    }
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
/**
 * The session id is a capability: it is the only thing the session routes ask
 * for, and it is in the path of every request. Hono's logger prints the whole
 * path, so an hour of stdout — `docker logs`, journald, a pasted crash dump —
 * is an hour of live sessions to read, destroy or push a clip into.
 */
const SESSION_ID_IN_PATH = /\/sessions\/[^/\s?]+/g;
app.use(
  "*",
  logger((message, ...rest) => console.log(message.replace(SESSION_ID_IN_PATH, "/sessions/<id>"), ...rest)),
);
// The mobile app is not a browser and needs no CORS. Sending permissive headers
// by default would let any web page the user visits spend the operator's budget
// and read back what the household watched, so this is opt-in.
if (config.corsOrigin) app.use("*", cors({ origin: config.corsOrigin }));

/**
 * ...and not sending them is only half of it. A browser will still *deliver* a
 * cross-origin request that needs no preflight — a form post, or a fetch with
 * `mode: "no-cors"` — and act on nothing but the reply, which it cannot read.
 * So any page the user happens to have open can create sessions from their
 * address until the per-caller ceiling is reached and their own app is
 * answered 503. Every browser attaches Origin to such a request; the app is
 * not a browser and attaches none, so refusing the ones we did not allow costs
 * it nothing.
 */
app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && origin !== config.corsOrigin) return c.json({ error: "cross-origin request refused" }, 403);
  return next();
});

/**
 * What is wrong with `CORS_ORIGIN`, in words, or null.
 *
 * `*` is the usual spelling of "any origin" and Hono's own default, so it is
 * the value an operator reaches for — and with the Origin gate above it is
 * self-contradictory: the preflight is answered 204 with
 * `Access-Control-Allow-Origin: *` and the request that follows is refused 403,
 * because no real Origin header is ever the literal `*`. Making the gate honour
 * it would mean letting every page on the internet spend the operator's budget,
 * which is the one thing this setting exists to prevent, so the server says so
 * and stops instead of running in a shape nobody asked for.
 */
export function corsConfigProblem(origin = config.corsOrigin): string | null {
  if (origin?.trim() !== "*") return null;
  return (
    "CORS_ORIGIN=* would let any web page a user visits spend your Claude budget and read back what they watched. " +
    "Name the one origin you serve from (CORS_ORIGIN=https://dashboard.example), or leave it unset — the app needs no CORS."
  );
}

/** A token nobody has to guess: the example file's own value, or too short to matter. */
export function weakToken(token: string): boolean {
  const t = token.trim();
  // A substring, not the whole string: every placeholder spelled out end to end
  // is shorter than the length rule beside it, so a whole-string match here
  // never decided anything. What is actually found in a half-edited .env is a
  // placeholder padded out to look like a secret, and only this catches those.
  return t.length < 24 || /change-?me|placeholder|example|secret|password|tvsham|token/i.test(t);
}

/** Compare two secrets in constant time, whatever the presented one is. */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenMatches(header: string, expected: string): boolean {
  return secretMatches(header.startsWith("Bearer ") ? header.slice(7) : "", expected);
}

/**
 * Wrong bearer tokens, per caller bucket. The token is one shared secret that
 * gates every paid request, and a 401 costs the guesser nothing: no delay, no
 * counter and nothing in the log to notice. A handful of wrong answers a
 * minute is all a person mistyping one needs.
 */
const wrongTokens = new Map<string, { until: number; count: number }>();
const WRONG_TOKEN_WINDOW_MS = 60_000;
const WRONG_TOKENS_ALLOWED = 10;

/** Attempts left in this bucket's window; 0 is the last one, below 0 is past it. */
function countWrongToken(bucket: string, now = Date.now()): number {
  for (const [key, seen] of wrongTokens) if (seen.until <= now) wrongTokens.delete(key);
  // A flood of distinct callers is a memory question, not a guessing one.
  if (wrongTokens.size > 10_000) wrongTokens.clear();
  const seen = wrongTokens.get(bucket);
  if (!seen) {
    wrongTokens.set(bucket, { until: now + WRONG_TOKEN_WINDOW_MS, count: 1 });
    return WRONG_TOKENS_ALLOWED - 1;
  }
  seen.count++;
  return WRONG_TOKENS_ALLOWED - seen.count;
}

// Optional bearer-token gate for everything except the health check.
app.use("*", async (c, next) => {
  if (!config.appToken || c.req.path === "/health") return next();
  if (tokenMatches(c.req.header("authorization") ?? "", config.appToken)) return next();
  const bucket = caller(c);
  const left = countWrongToken(bucket);
  // Said out loud, and only once a caller is really guessing: a log full of
  // 401s nobody reads is the same as no log at all.
  if (left === 0) console.warn(`[auth] ${bucket} is guessing the bearer token`);
  if (left <= 0) {
    c.header("Retry-After", String(Math.ceil(WRONG_TOKEN_WINDOW_MS / 1000)));
    return c.json({ error: "too many attempts" }, 429);
  }
  return c.json({ error: "unauthorised" }, 401);
});

// Reject oversized bodies before they are buffered (the content-length check alone
// can be sidestepped with chunked encoding). Every route gets a limit: JSON routes
// buffer their body too, so an unbounded one is just as good a way to exhaust memory.
app.use(
  "/sessions",
  bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: "body too large" }, 413) }),
);
// Ahead of that limit for clips, on purpose: with no Content-Length to read,
// bodyLimit drains the whole body into memory to measure it, so every check
// after it has already paid for the upload whatever it then answers.
app.on("POST", "/sessions/:id/clips", admitClip);
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
  // The other half of the same defence, for the one cross-origin request a
  // browser may send without an Origin: an HTML form, whose encodings are
  // text/plain, multipart/form-data and application/x-www-form-urlencoded. A
  // form cannot ask for application/json, and this route only ever takes that.
  const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type && type !== "application/json") return c.json({ error: "expected application/json" }, 415);
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
  // The only time the key is ever sent anywhere.
  const res: CreateSessionResponse = { sessionId: s.id, sessionKey: s.key };
  return c.json(res, 201);
});

/**
 * Whether this request holds the session's own key.
 *
 * The id names a session; it does not authorise one. It is in the path of every
 * request, so it is in the app's logs, in any proxy's access log, and was in
 * this server's until the logger above was made to redact it. The key is
 * returned once, at creation, carried in a header and never printed.
 *
 * Binding to the caller's address instead was considered and is wrong for this
 * app: the client is a phone in the middle of a record-upload-repeat loop, and
 * walking out of the house, a carrier NAT rotating, or a VPN reconnecting would
 * answer its own next clip with a 404. A miss is 404 rather than 403, so the
 * answer does not confirm the id exists.
 */
function holdsSessionKey(c: Context, s: Session): boolean {
  return secretMatches(c.req.header("x-session-key") ?? "", s.key);
}

app.get("/sessions/:id", (c) => {
  const s = getSession(c.req.param("id"));
  if (!s || !holdsSessionKey(c, s)) return c.json({ error: "no such session" }, 404);
  return c.json(describe(s));
});

app.delete("/sessions/:id", (c) => {
  const s = getSession(c.req.param("id"));
  // Silent either way, so a 204 does not confirm the id belonged to anyone.
  if (s && holdsSessionKey(c, s)) deleteSession(s.id);
  return c.body(null, 204);
});

/**
 * Uploads whose body is being read, queued or analysed right now.
 *
 * `parseBody` materialises the whole multipart body — up to maxUploadBytes — in
 * the request's own turn, and processClip then copies it into a Buffer, so each
 * upload in flight costs roughly twice the clip in resident memory until it is
 * finished with. Sessions are unauthenticated and cheap to make, so without a
 * ceiling here a burst of large clips is an out-of-memory kill rather than a
 * 503. Counted around the whole request, because the File stays alive for as
 * long as the clip is being worked on.
 */
let uploadsInFlight = 0;

/**
 * ...and how many of them each caller is holding. A body is only released when
 * the whole of it has arrived, and nothing makes a client deliver it promptly,
 * so one address dribbling a byte at a time into half a dozen sockets would
 * otherwise answer every real upload with a 503 for free. Bounded per caller
 * the way sessions are, and cleared as each upload ends so the map cannot grow.
 */
const uploadsByCaller = new Map<string, number>();

function holdUploadSlot(billTo: string): void {
  uploadsInFlight++;
  uploadsByCaller.set(billTo, (uploadsByCaller.get(billTo) ?? 0) + 1);
}

function releaseUploadSlot(billTo: string): void {
  uploadsInFlight--;
  const held = (uploadsByCaller.get(billTo) ?? 1) - 1;
  if (held > 0) uploadsByCaller.set(billTo, held);
  else uploadsByCaller.delete(billTo);
}

/**
 * Everything about an upload that can be decided without its body, decided
 * before a byte of it is read: whether the session exists, whether it still
 * wants clips, whether this is a retry of one already analysed, whether the
 * caller has quota left, and whether there is room to hold another body in
 * memory. Registered ahead of the body-limit middleware, which is what makes
 * "before the body is read" true for an upload that arrives without a
 * Content-Length as well as one that carries it.
 */
async function admitClip(c: Context<AppEnv, "/sessions/:id/clips">, next: Next) {
  // Read now, while the socket is still open: the work below runs after a queue
  // wait, by which time a disconnected client has no address to bill.
  const billTo = caller(c);
  const s = getSession(c.req.param("id"));
  if (!s || !holdsSessionKey(c, s)) return c.json({ error: "no such session" }, 404);
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
  // An over-quota caller should not get to make us buffer the body at all. The
  // quota itself is only spent further down, once the clip is really analysed.
  if (usage.remaining(billTo) <= 0) return overLimit(c, s);
  // Nor should anyone get to make us buffer more bodies at once than this
  // process has memory for. The limiter below bounds how many clips are
  // *analysed* at a time, which is a different thing: parseBody materialises
  // the whole upload before any of that is reached.
  if (
    uploadsInFlight >= config.maxUploadsInFlight ||
    (uploadsByCaller.get(billTo) ?? 0) >= config.maxUploadsPerCaller
  ) {
    c.header("Retry-After", "5");
    return c.json({ error: "server busy, try again shortly" }, 503);
  }
  holdUploadSlot(billTo);
  try {
    c.set("clip", { session: s, billTo, ...(headerKey ? { clipKey: headerKey } : {}) });
    return await next();
  } finally {
    releaseUploadSlot(billTo);
  }
}

/**
 * Upload one clip. Multipart form with a `clip` file field (mp4 / mov / webm).
 * The response reflects *all* clips in the session so far.
 */
app.post("/sessions/:id/clips", async (c) => {
  const { session, billTo, clipKey } = c.get("clip");
  return receiveClip(c, session, billTo, clipKey);
});

/** The rest of the upload: everything from here on holds the clip in memory. */
async function receiveClip(c: Context, s: Session, billTo: string, headerKey: string | undefined) {
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
}

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

/**
 * Delete staged clips nobody is coming back for. `processClip` removes its own
 * work directory in a `finally`, which covers a thrown error but not a SIGKILL,
 * an out-of-memory kill or a container restart mid-analysis — and what is left
 * behind is a recording of somebody's living room, in a server whose README
 * promises the clip is deleted as soon as it has been analysed. `olderThanMs`
 * of 0 removes everything, which is what a fresh start wants; the periodic
 * sweep passes an age instead so it cannot delete a directory in use.
 */
export async function sweepTmpDir(olderThanMs = 0, now = Date.now()): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(config.tmpDir);
  } catch {
    return 0; // No directory yet, or not readable: nothing to sweep either way.
  }
  let removed = 0;
  for (const name of entries) {
    const full = path.join(config.tmpDir, name);
    try {
      if (olderThanMs > 0) {
        const stat = await fs.stat(full);
        if (now - stat.mtimeMs < olderThanMs) continue;
      }
      await fs.rm(full, { recursive: true, force: true });
      removed++;
    } catch {
      // Raced with the request that owns it; the next sweep will get it.
    }
  }
  return removed;
}

async function main(): Promise<void> {
  const corsProblem = corsConfigProblem();
  if (corsProblem) {
    // Refused rather than warned about: the alternative is a server that
    // answers every preflight yes and every request no.
    console.error(`[server] ${corsProblem}`);
    process.exit(1);
  }
  const sttProblem = sttWarning();
  if (sttProblem) {
    // Fail loudly rather than transcribing to somewhere the operator did not choose.
    console.error(`[server] ${sttProblem}`);
    process.exit(1);
  }
  await fs.mkdir(config.tmpDir, { recursive: true });
  // Nothing is in flight yet, so anything here is left over from a hard stop.
  await sweepTmpDir();
  setInterval(() => {
    sweepSessions();
    void sweepTmpDir(config.sessionTtlMs);
  }, 60_000).unref();
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("[server] ANTHROPIC_API_KEY is not set; recognition requests will fail until it is.");
  }
  if (!config.appToken) {
    console.warn("[server] APP_TOKEN is not set: anyone who can reach this port can spend your API budget. Set it for anything beyond a private LAN.");
  } else if (weakToken(config.appToken)) {
    // Said as loudly as a missing one. A half-edited .env is otherwise a token
    // that looks set, is in a public example file, and never gets noticed.
    console.warn("[server] APP_TOKEN is short or a placeholder: it is the only thing between this port and your API budget. Generate one with: openssl rand -hex 32");
  }
  console.log(`[server] ffmpeg: ${(await ffmpegBinary()) ?? "NOT FOUND"}`);
  console.log(`[server] model: ${config.model}, stt: ${sttProvider().name}`);
  serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: config.host,
      // Node waits five minutes for a request body by default, which is five
      // minutes an upload slot is held by a client that has stopped sending.
      serverOptions: {
        requestTimeout: config.requestTimeoutMs,
        headersTimeout: config.headersTimeoutMs,
      },
    },
    (info) => {
      // The address it really bound, not a hard-coded one: the whole point of
      // the setting is that the two used to disagree.
      console.log(`[server] listening on http://${config.host}:${info.port}`);
    },
  );
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
