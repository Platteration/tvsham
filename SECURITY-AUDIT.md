# tvsham — security audit (2026-09-11)

A dedicated security pass, separate from and later than the review in `REVIEW.md`. Specialist reviewers read the repository through 3 independent lenses (L1, L2, L3), each required to *demonstrate* a finding rather than argue for it.

**13 findings** — 2 high, 2 medium, 8 low, 1 info. 9 of 13 were reproduced with command output; the others are reasoned from the code.

## Status

Every finding below was fixed on `claude/repo-review-security-baiyud` in 87f90ab, each with a regression test that was checked by reverting the fix and confirming the test fails. The findings are kept as written so the reasoning behind each change stays with it.

These were deliberately left for a decision rather than guessed at:

- L3-4 — refusing to POST a clip over public http:. It would break a public-http server, and isPrivateHost accepts neither a bare LAN hostname nor a real domain pointed at a LAN address by split-horizon DNS. The honesty half is done.
- L3-5 — excluding staged clips from device backup. expo-file-system exposes no iOS API for it, and on Android the one-line option also stops the user's saved library being restored to a new phone.
- SEC-9 — /health still reports the configured models and limits to an unauthenticated caller when APP_TOKEN is set.

## Findings

### L1-1 · high — Multi-stream video is a decode bomb: assertDecodable's pixel/duration budget bounds one stream, never the count, so a tiny upload allocates gigabytes and OOMs the server

`apps/server/src/media.ts`:143 · CWE-400 · reproduced

**Who.** Anyone who can reach the /sessions/:id/clips route: unauthenticated by default (APP_TOKEN off), and the shipped deployment is meant to sit behind a TLS proxy that app clients on the LAN or internet reach. No account, no token, no valid session content is needed beyond one crafted file well under the 80 MB upload cap.

**How.** 1. POST /sessions to get a session id (cheap, unauthenticated). 2. Build a Matroska/WebM/MP4 file containing many video streams, each at or under the per-stream pixel budget (e.g. 60 copies of a 4096x2304 stream = a 1.6 MB .mkv; 300 copies = 8.6 MB). ffmpeg picks the container demuxer from content, and matroska/webm/mp4 are all on -format_whitelist, so the file is accepted. 3. Upload it as the `clip` field. processClip -> assertDecodable -> probe() runs `ffmpeg -i file`, which initialises a decoder context for every input stream. probe() only records the *largest* single stream's WxH (4096x2304 = exactly maxPixels, so `pixels > maxPixels` is false) and coverPixels=0, so assertDecodable returns success. 4. extractFrames and extractAudio then each spawn ffmpeg over the same file (Promise.all), doubling the allocation. Fire a handful concurrently (MAX_UPLOADS_IN_FLIGHT defaults to maxConcurrent*2 = 6, maxConcurrent = 3 analyses at once).

**Why it matters.** Denial of service by memory exhaustion from a single ~1.6 MB unauthenticated request. The docker-compose ships mem_limit: 2g; a 60-stream 1.6 MB upload allocates ~1.5 GB during the probe alone (before any budget check can reject it) and again during extraction, so one request OOM-kills the container and drops every in-flight session; larger stream counts reach 4+ GB. On a bare `npm run server` host it competes with the host OOM killer. The 20 s ffmpeg timeout does not help: the allocation is reached in ~1-2 s, long before the deadline.

**Evidence.**

media.ts assertDecodable (line 143-162) checks only p.width*p.height and p.coverPixels against config.maxPixels and p.seconds against maxDurationSeconds; probe() (line 82-132) explicitly takes only the single largest stream ('Take the largest video stream, not the first one listed'). grep for any stream-count/nb_streams guard across apps/server/src returns nothing. INPUT_GUARDS (line 58-63) whitelists matroska,webm,mp4,avi,mpegts as demuxers. Reproduced with the real code: node --import tsx over apps/server/src/media.ts, file = 60 within-budget streams (1.64 MB): probe() -> {"seconds":1,"width":4096,"height":2304,"coverPixels":0}; per-stream pixels 9437184 <= maxPixels 9437184 = true; assertDecodable ACCEPTED it; peak process-tree RSS 1529.5 MB in 2.44 s. extractFrames on the same file: peak 1520.8 MB in 1.2 s. Driving the actual Hono route (app.request POST /sessions/:id/clips) with a 150-stream 4.1 MB file: two concurrent ffmpeg children at ~2.6 GB RSS each and system memory driven from 3.6 GB used to 14.4 GB used (of 16 GB). A 300-stream 8.6 MB file drove a single probe to 4371.6 MB. maxDurationSeconds and maxPixels are never multiplied by stream count anywhere.

**Fix.** Bound the aggregate decode cost, not just one stream. In probe(), also count the number of video streams (and, better, sum their pixel areas), and in assertDecodable reject when the video-stream count exceeds a small cap (a phone recording has one) or when the summed pixels exceed a budget. Cheaper and safer: force single-stream decoding on every ffmpeg invocation by adding `-map 0:v:0` (frames) / `-map 0:a:0` (audio) so only the selected stream is opened, and pass `-i` after a `-probesize`/`-analyzeduration` cap plus a hard per-process memory cap (e.g. run ffmpeg under an rlimit / cgroup, or `-threads 1` is already set but does not bound memory). Add a media.test.ts case that builds a many-stream file whose largest stream is within maxPixels and asserts assertDecodable rejects it.


### L2-1 · high — TRUST_PROXY bills the caller by the leftmost X-Forwarded-For hop, which is the value the client sent, so the daily clip cap and the per-caller session ceiling are both reset by one header

`apps/server/src/index.ts`:103 · CWE-348 · reproduced

**Who.** Anyone who can reach the server in the deployment the README recommends for a public instance: a TLS reverse proxy in front of it and TRUST_PROXY=true behind it. They control only their own HTTP request headers; they need no credentials beyond APP_TOKEN if one is set (and APP_TOKEN is off by default, while DAILY_CLIP_LIMIT is presented as the independent spend control).

**How.** 1. Operator follows README 'Deploying safely': puts nginx/Caddy/HAProxy/ALB in front, sets TRUST_PROXY=true and DAILY_CLIP_LIMIT=N. 2. Every one of those proxies APPENDS the peer address to whatever X-Forwarded-For the client already sent (nginx's canonical `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`), so the header arriving at the server is `<whatever the client wrote>, <real client>`. 3. caller() reads `.split(",")[0]` — the client's own value — and hands it to addressBucket(). 4. The attacker sends a different first hop on every request (`X-Forwarded-For: 10.0.0.1`, `10.0.0.2`, ... or even a non-IP string, which addressBucket happily turns into `ip:not-an-ip`). 5. Every request lands in a fresh bucket, so usage.take() sees a fresh daily quota and sessionsHeldBy() sees a fresh caller.

**Why it matters.** The daily clip cap counts nothing: unlimited paid claude-opus-5 requests (adaptive thinking, effort high, up to 24 JPEGs and 6 web searches each) on the operator's Anthropic bill. MAX_SESSIONS_PER_CALLER also counts nothing, so one client can fill MAX_SESSIONS (500) and 503 every other user. This directly contradicts the invariant CLAUDE.md states — 'Bill callers by something they cannot choose' — and the README's explicit promise that the cap 'counts against the connecting address, never a header the caller sets, so it cannot be reset by rotating an id'. Note the other half of the same defect: with TRUST_PROXY left at its default false but a proxy in front, every request arrives from the proxy's address, so all users share one bucket and one attacker exhausts the daily cap and the 20-session ceiling for everybody. There is no configuration of this code in which a proxied deployment gets a correct caller identity.

**Evidence.**

apps/server/src/index.ts:101-115
```
export function caller(c: Context): string {
  if (config.trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return addressBucket(forwarded);
  }
```
and apps/server/src/index.ts:85 `if (!groups) return `ip:${bare}`;` — addressBucket never checks net.isIP on the value, so an arbitrary string becomes an arbitrary bucket.

The only existing test (apps/server/src/index.test.ts:172) asserts header-independence with trustProxy at its default false, so this path is untested; REVIEW.md:437 even lists 'caller() with trustProxy=true taking the first X-Forwarded-For hop' as a missing test, describing the behaviour without flagging it.

Ran (repo root, `node --import tsx`):
```
honest client  -> ip:203.0.113.9
spoof 1.1.1.1      -> ip:1.1.1.1
spoof 9.9.9.9      -> ip:9.9.9.9
spoof 2001:db8::1  -> ip6:2001:db8:0:0::/64
spoof not-an-ip    -> ip:not-an-ip

DAILY_CLIP_LIMIT=1, one real client, 50 requests -> 50 clips billed as allowed
```
and end to end through the real Hono app with MAX_SESSIONS_PER_CALLER=2:
```
honest client, MAX_SESSIONS_PER_CALLER=2 : 2/10 sessions created
same client, one header changed        : 50/50 sessions created
live sessions now held by one client    : 52
```

**Fix.** Count trusted hops from the RIGHT, not the left, and validate the result. Replace TRUST_PROXY with a hop count (keep TRUST_PROXY=true meaning 1 hop for compatibility): split x-forwarded-for on ',', trim, and take `parts[parts.length - hops]` — the address the outermost trusted proxy itself observed — rather than `parts[0]`, which is whatever the client typed. Fall back to the socket address when the list is shorter than `hops`. Additionally, make addressBucket fail closed on anything that is not an address: at apps/server/src/index.ts:81-85 add `if (!net.isIP(bare)) return "ip:unknown";` before the IPv4/IPv6 branches, so a garbage header value cannot mint a private bucket. Optionally gate the header on the socket peer being in a TRUSTED_PROXY_CIDRS allowlist. Add two tests: (a) with trustProxy on, `X-Forwarded-For: <spoof>, <peer>` must bucket to `<peer>`; (b) a non-IP hop must bucket to `ip:unknown`. Fix the README sentence at line 76 and the .env.example comment at lines 26-29 to say the header is read from the proxy side.


### L3-1 · medium — MAX_UPLOADS_IN_FLIGHT never runs for an upload without Content-Length: Hono's bodyLimit buffers the whole body before the admission gate, before the session even has to exist

`apps/server/src/index.ts`:245 · CWE-770 · reproduced

**Who.** Anyone who can reach the port. No token (APP_TOKEN is unset by default), no session, no valid multipart body — just the ability to open TCP connections to the server, which is the normal state of a LAN deployment since the phone has to reach it.

**How.** 1. Open N connections and send `POST /sessions/<anything>/clips` with `Content-Type: multipart/form-data; boundary=x` and NO `Content-Length` header (or `Transfer-Encoding: chunked`). 2. Stream up to `maxUploadBytes` (80 MB) of arbitrary bytes on each. 3. Hono's bodyLimit middleware, which is registered on this path and therefore runs before the route handler, takes the no-Content-Length branch: it drains the entire body into a `chunks` array in memory to count it, then rebuilds a Request from those chunks. 4. Only after that does the handler run — where `getSession` 404s the nonexistent session and, for a real session, `uploadsInFlight >= config.maxUploadsInFlight` would have answered 503. Both checks happen after the memory has already been spent. 5. Repeat/hold: Node's default `requestTimeout` of 300 s gives each connection five minutes to deliver its 80 MB, and there is no cap on how many are buffering at once.

**Why it matters.** Unbounded heap growth from unauthenticated requests. 26 concurrent 80 MB chunked POSTs exceed the `mem_limit: 2g` the compose file sets, so the container is OOM-killed and restarted (`restart: unless-stopped`), losing every in-flight analysis and every live session. This is precisely the outcome MAX_UPLOADS_IN_FLIGHT was added to prevent: SEC-2's fix, the CLAUDE.md invariant 'Admit an upload before its body is read... so MAX_UPLOADS_IN_FLIGHT is counted at request entry', the comment at index.ts:198-208 ('Sessions are unauthenticated and cheap to make, so without a ceiling here a burst of large clips is an out-of-memory kill rather than a 503') and the README's 'Uploads that may be in memory at once, counted before the body is read' are all true only for uploads that carry a Content-Length. The attacker chooses whether to send one.

**Evidence.**

node_modules/hono/dist/middleware/body-limit/index.js:
```
const hasTransferEncoding = c.req.raw.headers.has("transfer-encoding");
const hasContentLength = c.req.raw.headers.has("content-length");
if (hasContentLength && !hasTransferEncoding) {
  const contentLength = parseInt(...);
  return contentLength > maxSize ? onError(c) : next();
}
let size = 0;
const chunks = [];
const rawReader = c.req.raw.body.getReader();
for (; ; ) { const { done, value } = await rawReader.read(); if (done) break; size += value.length; if (size > maxSize) return onError(c); chunks.push(value); }
```
That loop is the middleware registered at apps/server/src/index.ts:143-149, and it runs before the handler at :214 whose gate is :245 `if (uploadsInFlight >= config.maxUploadsInFlight) ... 503` and before :215 `const s = getSession(c.req.param("id")); if (!s) return c.json({ error: "no such session" }, 404);`.

Run output (scratchpad/sec/work/chunked.mts, MAX_UPLOADS_IN_FLIGHT=1):
```
maxUploadBytes=80MB  maxUploadsInFlight=1
POST to a session that does not exist -> HTTP 404
megabytes the server read off the wire before answering: 70
```
Run output (scratchpad/sec/work/chunked3.mts, 12 concurrent chunked uploads of 60 MB at a session that does not exist, MAX_UPLOADS_IN_FLIGHT=1):
```
RSS before: 124 MB
  t=1000ms  MB delivered=720  RSS=851 MB
  t=3000ms  MB delivered=720  RSS=851 MB
  t=6000ms  MB delivered=720  RSS=851 MB
statuses: 404  total MB delivered=720
```
720 MB resident with the in-flight ceiling set to one.

The auth gate does stop it when APP_TOKEN is set, because it is registered earlier (index.ts:130). scratchpad/sec/work/chunked4.mts:
```
APP_TOKEN set, no Authorization -> HTTP 401; MB read off the wire = 1
APP_TOKEN set, correct bearer, unknown session -> HTTP 404; MB read = 30
```

**Fix.** Do not let the body-limit middleware be the thing that reads the body. Either (a) move the admission counter into a middleware registered BEFORE the bodyLimit middleware for `/sessions/:id/clips` — increment there, release in a `finally`, and do the session-existence check there too so an unknown session is refused before a byte is buffered; or (b) better, stop buffering at all: reject a clip upload that arrives with no `Content-Length` (the app's own `fetch` always sets one for a FormData file upload, so this costs nothing in practice) and stream the body straight to `clipPath` instead of `parseBody`. Also give the request body its own read deadline rather than relying on Node's 300 s `requestTimeout` (see L3-3), and add a test that sends a chunked body to a nonexistent session and asserts the server did not read it.


### L3-2 · medium — With TRUST_PROXY=true the caller bucket is the leftmost X-Forwarded-For entry, which any client can prepend: DAILY_CLIP_LIMIT and MAX_SESSIONS_PER_CALLER are both bypassable, and another user's address can be billed instead

`apps/server/src/index.ts`:103 · CWE-348 · reproduced

**Who.** Any client that can send an HTTP request through the operator's reverse proxy. This is the deployment the README tells a public operator to run: 'Put TLS in front of it (a reverse proxy or your host's ingress)' plus 'Behind a proxy, set TRUST_PROXY=true so the real client address is used'.

**How.** 1. The operator fronts the server with nginx (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` — the snippet in nginx's own docs and in every copy-pasted config), or Traefik, Caddy, an AWS ALB or Cloudflare. All of these APPEND the real client address to whatever `X-Forwarded-For` the client sent, producing `<attacker value>, <real client ip>`. 2. `caller()` takes `c.req.header("x-forwarded-for")?.split(",")[0]` — the leftmost entry, i.e. the attacker's own string. 3. The attacker sends a different leftmost value on every request. `addressBucket` hands back a fresh bucket each time, so `usage.take(billTo)` never reaches `DAILY_CLIP_LIMIT` and `sessionsHeldBy(owner)` never reaches `MAX_SESSIONS_PER_CALLER`. 4. Variants: send a value that is not an IP at all (`X-Forwarded-For: aaaa`) and the bucket is literally `ip:aaaa`; send an empty first element and everyone lands in the shared `ip:unknown` bucket; send a victim's address to spend THEIR daily quota and lock them out.

**Why it matters.** The one cost ceiling on a public instance is gone. Each bypassed clip is a full claude-opus-5 request with up to 24 JPEG frames, adaptive thinking at high effort and up to six web searches, plus a second structured-extraction call — an unmetered tab on the operator's Anthropic bill, which the README names as the reason DAILY_CLIP_LIMIT exists ('an unmetered public server is an open tab'). The per-caller session cap added for MISS-1 goes with it, so one client can still take every session slot. The attacker can also target a specific victim's bucket to deny them service. This breaks the CLAUDE.md invariant verbatim: 'Bill callers by something they cannot choose... Counting X-Device-Id or an untrusted X-Forwarded-For lets anyone reset the daily cap by editing a header.' The existing regression test (index.test.ts:163-173) only passes because `config.trustProxy` is false under `npm test`; nothing covers the trusted-proxy path. Note also that the operator is pushed into this setting: with the shipped compose file (`127.0.0.1:8787:8787`) and a host-side reverse proxy, every connection reaches the container from the Docker bridge gateway, so with TRUST_PROXY left off `caller()` returns one bucket for the whole world and the same two caps become global — one client exhausts them for everybody. There is no correct setting of this flag today.

**Evidence.**

apps/server/src/index.ts:101-115:
```
export function caller(c: Context): string {
  if (config.trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return addressBucket(forwarded);
  }
  ...
```
and apps/server/src/config.ts:75 `trustProxy: env("TRUST_PROXY") === "true"` — a boolean, with no notion of how many hops are actually trusted.

Run output (scratchpad/sec/work/xff.mts, TRUST_PROXY=true, MAX_SESSIONS_PER_CALLER=2, real client 203.0.113.9 behind an appending proxy):
```
real client 203.0.113.9 behind an appending proxy, sending its own XFF:
  XFF="1.1.1.1, 203.0.113.9" -> bucket "ip:1.1.1.1"
  XFF="2.2.2.2, 203.0.113.9" -> bucket "ip:2.2.2.2"
  XFF="not-an-ip, 203.0.113.9" -> bucket "ip:not-an-ip"
  XFF=", 203.0.113.9" -> bucket "ip:unknown"

POST /sessions with rotating leftmost XFF, MAX_SESSIONS_PER_CALLER=2:
  created=8 refused=0
Same caller, honest header (no spoof):
  created=2 refused=6
```

Run output (scratchpad/sec/work/quota.mts, TRUST_PROXY=true, DAILY_CLIP_LIMIT=1, real 2-second mp4 built with ffmpeg, Anthropic client stubbed so paid calls can be counted):
```
Honest header (proxy value only):
  upload 1 -> HTTP 200
  upload 2 -> HTTP 429
  upload 3 -> HTTP 429
  paid Claude calls so far: 1

Same client, prepending its own X-Forwarded-For each time:
  upload 1 -> HTTP 200
  upload 2 -> HTTP 200
  upload 3 -> HTTP 200
  upload 4 -> HTTP 200
  upload 5 -> HTTP 200
  paid Claude calls total: 6
```

**Fix.** Count X-Forwarded-For from the RIGHT, not the left, and say how many hops are trusted. Replace the boolean with a hop count: `TRUST_PROXY=<n>` (n>=1), and in `caller()` take `parts[parts.length - n]` after splitting and trimming, falling back to the socket address when there are fewer than n entries — the rightmost entries are the ones the operator's own proxies appended and are the only ones a client cannot forge. Reject an entry that is not a valid IPv4/IPv6 literal (`net.isIP`) rather than turning it into a bucket string, so `ip:not-an-ip` can never exist. Add tests asserting that (a) `X-Forwarded-For: 1.1.1.1, <real>` with TRUST_PROXY=1 buckets on `<real>`, and (b) a non-IP entry is not accepted. Separately, document in the README that a loopback-published container behind a host proxy sees the Docker bridge gateway for every client, so the hop count must be set for the caps to mean anything.


### L2-2 · low — Any web page the user visits can exhaust the per-caller session ceiling with a preflight-free cross-origin POST, locking the real app out with 503

`apps/server/src/index.ts`:165 · CWE-352 · reproduced

**Who.** Any web page the operator or a household member opens on a device that can reach the server — the stated threat model for a self-hosted service. They control only the page's own JavaScript; they need no credentials because APP_TOKEN is off by default and the README only advises setting it when the server is 'reachable beyond your own LAN', which a LAN-only install is not.

**How.** 1. The page runs `fetch('http://192.168.1.20:8787/sessions', {method:'POST', mode:'no-cors', body:'{\"source\":\"camera\"}'})` in a loop. Content-Type stays text/plain, no custom headers, so this is a CORS 'simple request': no preflight, and the absence of Access-Control-Allow-Origin does not stop it being delivered and executed. 2. POST /sessions calls `c.req.json().catch(() => ({}))`, which ignores Content-Type entirely, so the session is created. 3. After MAX_SESSIONS_PER_CALLER (20) the caller bucket — the device's own LAN address, shared with the real app — is full. 4. The page repeats every few minutes to outlast sessionTtlMs.

**Why it matters.** The user's own TVsham app gets `503 {"error":"too many open sessions from this address"}` on every capture for as long as the page keeps running, and for up to 15 minutes after it stops. The page cannot read the response (no CORS headers are sent), so it never learns a sessionId and cannot upload a clip or spend Claude budget — the impact is denial of service only. Setting APP_TOKEN closes it completely (the requests get 401), which is why this is low rather than medium.

**Evidence.**

apps/server/src/index.ts:120 `if (config.corsOrigin) app.use("*", cors({ origin: config.corsOrigin }));` — no CORS headers by default, which blocks *reading* the reply but not *sending* the request.
apps/server/src/index.ts:166 `const body = (await c.req.json().catch(() => ({}))) as {...}` — Content-Type is never checked, so a text/plain simple request is accepted.
apps/server/src/index.ts:173-179 — the only ceiling is per caller bucket, which is the device's own address.

Ran against the real app with no APP_TOKEN and no CORS_ORIGIN:
```
simple cross-origin POST /sessions -> 201 {"sessionId":"46277bb7-e134-4f29-9ed2-3020620b6898"}
CORS headers on that response      -> []
sessions created from one page: 20, refused: 21
the user's own app now gets     -> 503 {"error":"too many open sessions from this address"}
```

**Fix.** Require something a cross-origin simple request cannot send, so the browser is forced into a preflight that fails without CORS_ORIGIN. Cheapest: in POST /sessions (and POST /sessions/:id/clips), reject unless the request carries a header a browser cannot set cross-origin without preflight — `Content-Type: application/json` for /sessions (the app already sends it, api.ts:217) and the existing `X-Clip-Key` or `X-Device-Id` for clips. Return 415/400 otherwise. Add a test asserting `POST /sessions` with `content-type: text/plain` is refused. (Do not rely on an Origin allowlist alone: non-browser callers send no Origin.)


### L2-3 · low — The session id is the only per-session authorisation and it is written in clear to the request log on every request; GET, DELETE and clip upload never check the session's owner

`apps/server/src/index.ts`:116 · CWE-532 · reproduced

**Who.** Anyone who can read the server's stdout — `docker logs`, journald, a log shipper, a pasted crash dump, a shared tmux — combined with the ability to reach the port (which for a household server with a shared APP_TOKEN means any other user of that server, or anyone at all when APP_TOKEN is unset, the default).

**How.** 1. Read the request log. Every line of the form `--> GET /sessions/bfe2376d-1878-4b63-b0bc-393cd9e6a563 200 1ms` hands over a live session capability (sessions live up to SESSION_MAX_AGE_MS = 1h). 2. `GET /sessions/<id>` returns that household's identification, links, cast and where-to-watch with no owner check. 3. `DELETE /sessions/<id>` destroys someone else's in-flight capture. 4. `POST /sessions/<id>/clips` pushes an attacker-chosen clip into it; the victim's app is polling that same id and will render and save the attacker's identification as its own answer, billed to the attacker's bucket.

**Why it matters.** Disclosure of what the household was watching, destruction of another user's session, and injection of a false answer into another user's result screen and saved library. Bounded by needing log access, and fully closed for outsiders when APP_TOKEN is set — hence low. It is nevertheless a capability token in a plaintext log, and the routes that consume it perform no authorisation of their own even though Session already records `owner` (sessions.ts:23) for exactly this kind of question.

**Evidence.**

apps/server/src/index.ts:116 `app.use("*", logger());` — Hono's logger builds its line as `const path = url.slice(url.indexOf("/", 8))` (node_modules/hono/dist/middleware/logger/index.js), i.e. the whole path and query string, so the UUID is logged twice per request.
apps/server/src/index.ts:186-195
```
app.get("/sessions/:id", (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "no such session" }, 404);
  return c.json(describe(s));
});
app.delete("/sessions/:id", (c) => {
  deleteSession(c.req.param("id"));
  return c.body(null, 204);
});
```
and index.ts:214-216 for the clip route — none of the three compares `s.owner` with `caller(c)`.

Ran with APP_TOKEN set, captured stdout:
```
<-- POST /sessions
--> POST /sessions 201 3ms
<-- GET /sessions/bfe2376d-1878-4b63-b0bc-393cd9e6a563
--> GET /sessions/bfe2376d-1878-4b63-b0bc-393cd9e6a563 200 1ms

(the capability for that session is bfe2376d-1878-4b63-b0bc-393cd9e6a563)
```

**Fix.** Two independent changes. (1) Stop logging the capability: replace `app.use("*", logger())` with `app.use("*", logger((message) => console.log(message.replace(/\/sessions\/[0-9a-f-]{36}/gi, "/sessions/<id>"))))`, or drop the logger and log method + route pattern + status yourself. (2) Bind the routes to their owner: in GET, DELETE and POST /sessions/:id/clips, compare `s.owner` with `caller(c)` and return the same 404 body when they differ (404, not 403, so the id is not confirmed). Keep a documented escape hatch if two devices behind one address are expected to share — they already share a bucket, so the check costs nothing in the normal case. Add a test asserting a session created by one bucket is 404 for another.


### L2-4 · low — .env.example offers a literal guessable APP_TOKEN and nothing throttles or logs failed bearer attempts

`apps/server/.env.example`:11 · CWE-1392 · reproduced

**Who.** Anyone who can reach the port on a server the operator believes is protected because they set APP_TOKEN.

**How.** 1. `curl http://host:8787/health` answers 200 with the model, ffmpeg status, STT provider, TMDB flag and dailyClipLimit even when APP_TOKEN is set, confirming this is a TVsham server and how expensive a clip is. 2. `POST /sessions` with `Authorization: Bearer change-me` — the literal value .env.example hands the operator, which an operator who uncomments the line without editing it will be running. 3. Failing that, guess at full request rate: the gate returns 401 with no delay, no counter, no lockout and no distinct log line, and the daily cap is never consulted on the 401 path, so there is nothing to exhaust.

**Why it matters.** Unlimited attempts against a single shared secret that gates all paid Claude usage and all stored session content, plus a documented literal value that is likely to be in use verbatim on some installs. The comparison itself is correct (timingSafeEqual behind a length check), so this is about the credential's strength and the absence of any attempt limit, not about the compare.

**Evidence.**

apps/server/.env.example:10-11
```
# Optional shared secret. When set, the app must send "Authorization: Bearer <token>".
# APP_TOKEN=change-me
```
apps/server/src/index.ts:130-134 — the gate returns 401 and returns; nothing counts the failure, and the bodyLimit and usage middleware are never reached on that path.
apps/server/src/index.ts:131 `if (!config.appToken || c.req.path === "/health") return next();` — /health stays unauthenticated and discloses the configuration (this is REVIEW.md's SEC-9, which appears on neither the 'fixed' nor the 'deliberately not done' list and is still present in the code).

Probed the gate directly; it is otherwise sound — `/HEALTH`, `/health/`, `//health`, `/health/../sessions`, `/health%00/sessions`, `/sessions?/health`, `/sessions;/health` all return 401, and `bearer`/`BEARER`/bare-token/`Bearer <token>X` are all rejected:
```
   401 /sessions
   200 /health
   401 /HEALTH
   401 /health/
   401 //health
   401 /health/../sessions
   401 /health%00/sessions
   401 /sessions;/health
   201 "Bearer s3cret-token"
   401 "bearer s3cret-token"
   401 "Bearer s3cret-tokenX"
   401 "Bearer "
```

**Fix.** Three small changes. (1) In .env.example line 11, replace the literal with an instruction that produces entropy: `# APP_TOKEN=  # generate with: openssl rand -hex 32`. (2) In config.ts, refuse to start (or warn as loudly as the missing-token warning already does) when APP_TOKEN is set but shorter than 24 characters or equal to a known placeholder, so a half-edited .env is caught at boot rather than never. (3) Count failed bearer attempts per caller bucket in the existing usage-store style and answer 429 with Retry-After after a handful, and log the failures distinctly so they are visible. Separately, close SEC-9 by returning `{ ok: true, version }` to unauthenticated callers and the full HealthResponse only when the request carries the token — the Docker HEALTHCHECK only needs the 200.


### L3-3 · low — Six slow request bodies hold every upload slot indefinitely, so every real upload gets 503 — free, unauthenticated, and sustained

`apps/server/src/index.ts`:259 · CWE-400 · reproduced

**Who.** Anyone who can reach the port. No token needed by default; sessions are free to create (20 per caller bucket).

**How.** 1. `POST /sessions` a handful of times to get session ids (free, 4 KB bodies). 2. For each, open a raw TCP connection and send the request line and headers for `POST /sessions/<id>/clips` with `Content-Type: multipart/form-data; boundary=x` and a large `Content-Length` (e.g. 40 MB). 3. Send the first few bytes of the multipart preamble, then one byte every two seconds. Because a Content-Length IS present, hono's bodyLimit waves the request through immediately; the handler increments `uploadsInFlight` and then blocks in `await c.req.parseBody()` waiting for a body that never arrives. 4. Do this `MAX_UPLOADS_IN_FLIGHT` times (default `MAX_CONCURRENT * 2` = 6). 5. Reconnect every ~4 minutes, before Node's default 300 s `requestTimeout` closes each socket.

**Why it matters.** Every legitimate upload answers `503 {"error":"server busy, try again shortly"}` with `Retry-After: 5`, for as long as the attacker keeps six sockets open at roughly half a byte per second. The app then treats this as a server error, so clips pile up in the on-device offline queue (capped at 10, after which the oldest recordings are deleted) and the user never gets an answer. It costs the attacker no bandwidth, no Claude spend and no ffmpeg work, so unlike the budget-burn path there is nothing that makes it expensive to sustain. There is no read deadline anywhere on the request body — `parseBody` is awaited with no signal, and the only bound is Node's `requestTimeout`, which the attacker simply reconnects around.

**Evidence.**

apps/server/src/index.ts:249-254:
```
  uploadsInFlight++;
  try {
    return await receiveClip(c, s, billTo, headerKey);
  } finally {
    uploadsInFlight--;
  }
```
and :258-259 `async function receiveClip(...) { const form = await c.req.parseBody();` — the slot is taken before the body is read and released only when the whole body has arrived, with no deadline on that wait.

Run output against the real server started as `node --import tsx apps/server/src/index.ts` on port 8901 with default settings (MAX_UPLOADS_IN_FLIGHT = 2 x MAX_CONCURRENT = 6):
```
6 slow POSTs open (1 byte every 2 s, Content-Length 40 MB each).
legitimate upload while they are held: HTTP 503 {"error":"server busy, try again shortly"}
Retry-After: 5
```
The same run with MAX_UPLOADS_IN_FLIGHT=2 needed only two sockets.

**Fix.** Put a deadline on receiving the body, not only on analysing it. Wrap `c.req.parseBody()` in a race against a timer sized to the clip (e.g. 60-120 s) and abort the request when it expires, so a socket that stops delivering releases its slot; and lower Node's own limits by passing `serverOptions: { requestTimeout: 120_000, headersTimeout: 15_000 }` (and a `maxConnections`) to `serve()` in `main()`. A minimum-throughput check (bytes received per second) is the belt-and-braces version. Fixing L3-1 by streaming the body to disk does not fix this on its own — the slot is still held for as long as the client dribbles.


### L3-4 · low — The Android cleartext opt-in is global, not local-network-scoped as its plugin claims, and the app-level rule it defers to only withholds the token — not the recording

`apps/mobile/plugins/withLocalNetworkCleartext.js`:20 · CWE-319 · reasoned

**Who.** Anyone on the path between the phone and the server — a shared Wi-Fi network (flat, hotel, café, office), a hostile hotspot, or any hop on the public internet — when the user has configured a public `http://` server URL, which the app permits and merely warns about.

**How.** 1. The user is told by the README that TVsham talks to 'a small Node server you host yourself' and types its address into Settings. Anything that parses as `http:`/`https:` with a hostname is accepted (`cleanServerUrl`); a public `http://` host produces a warning string in Settings but is saved and used. 2. On Android the config plugin sets `android:usesCleartextTraffic="true"` on the application element, which is the shortcut for a network-security-config base-config with `cleartextTrafficPermitted="true"` for EVERY domain — not for private ranges. The platform therefore permits the connection. 3. Every 8-second clip (video and audio of the user's living room, or a screen recording of their phone), the device id, the region, the hint, and every response travels in the clear. 4. The attacker reads the recordings off the wire, and can rewrite the response: `isSafeWebUrl` accepts `http:` as well as `https:`, so an injected link is opened in a Custom Tab or, for a link tagged `provider: "youtube"|"tiktok"|"instagram"`, handed to `Linking.openURL`, where any installed app with a matching intent-filter can claim it.

**Why it matters.** On Android the platform imposes no limit on where cleartext may go, and the app-layer rule the plugin's own comment points at ('The app's own rule is the narrower one and is enforced in src/settings.ts') covers only the bearer token: `headers()` in api.ts throws solely when a token is set, so with no token — the default, since APP_TOKEN is off by default server-side — clips and results go over plain HTTP to any public host without objection. The same configuration is simply blocked on iOS, where the app declares only `NSAllowsLocalNetworking` (which exempts .local names, unqualified hostnames and RFC1918/link-local literals, not public hosts), so the two platforms disagree about what the app is allowed to do with the user's recordings. The scope mismatch is not documented anywhere: app-config.test.ts asserts `NSAllowsArbitraryLoads !== true` on iOS and then asserts exactly the Android equivalent of arbitrary loads.

**Evidence.**

apps/mobile/plugins/withLocalNetworkCleartext.js:17-22:
```
module.exports = function withLocalNetworkCleartext(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    application.$["android:usesCleartextTraffic"] = "true";
```
against apps/mobile/app.json:19-21:
```
"NSAppTransportSecurity": { "NSAllowsLocalNetworking": true }
```
apps/mobile/src/api.ts:29-42 — the only enforcement:
```
const token = getSettings().token.trim();
if (token) {
  if (!canSendTokenTo(base)) { throw new ApiError("Refusing to send your access token over plain HTTP ..."); }
  h.Authorization = `Bearer ${token}`;
}
```
Nothing guards the clip body or the response. apps/mobile/src/settings.ts:92-101 `serverUrlWarning` returns a string; `cleanServerUrl` still returns the URL, and `updateSettings` still stores it.
The test at apps/mobile/src/app-config.test.ts:32 asserts iOS does not set `NSAllowsArbitraryLoads`, while :51 asserts Android sets the manifest attribute that is its exact equivalent.

**Fix.** Make the platform policy match the app's stated rule. Replace the blanket attribute with an Android network-security-config resource whose base-config is `cleartextTrafficPermitted="false"` and which permits cleartext only for the local names the app actually needs (`localhost`, `*.local`, `*.home.arpa`) — and, because Android's config cannot express private CIDRs, close the remaining gap at the app layer: have `cleanServerUrl` (or the point of use in `api.ts`) refuse `http:` to a host that is not `isPrivateHost`, for the clip upload and the session calls as well as for the token, rather than only warning. At minimum, rename the plugin and rewrite its comment so it does not claim a scope it does not have, and add a test asserting the app will not POST a clip to a public `http:` URL.


### L3-5 · low — Device backups carry the unsent recordings and the household's full watch history: allowBackup defaults to true and the iOS queue directory is never excluded

`apps/mobile/src/queue.ts`:45 · CWE-359 · reasoned

**Who.** Whoever can read a device backup: someone with access to the computer holding an unencrypted iOS Finder/iTunes backup (the default when no backup password is set), anyone who can restore the user's Google or Apple account onto a new device, or a forensic extraction of a synced machine. Not the phone's owner — this is the same threat class the repo already decided to defend against for the token.

**How.** 1. A clip recorded while the server was unreachable is moved out of the OS cache into `Paths.document/pending-clips/<id>.mp4` — on iOS `NSSearchPathForDirectoriesInDomains(.documentDirectory, ...)`, i.e. `<app>/Documents`, which iOS includes in iCloud and Finder backups unless `NSURLIsExcludedFromBackupKey` is set; on Android `getFilesDir()`, which Android Auto Backup includes. Nothing in the repo sets an exclusion flag or a `<data-extraction-rules>` / `<full-backup-content>` resource. 2. Up to ten such clips persist until the server answers — 'record now, get the answer when there is a connection', per the README, so on a plane or in a dead zone they persist for days. 3. In parallel, AsyncStorage holds `tvsham.library.v1` and `tvsham.history.v1` — the saved library plus the last 30 identifications, each with title, episode, year and timestamp — in plaintext (SQLite on Android, a plist on iOS), both inside the same backup set. 4. `android:allowBackup` is never set in app.json, and Expo's config plugin writes `android:allowBackup="true"` when it is absent.

**Why it matters.** A copy of the backup yields video and audio recordings of the inside of the user's home (or screen recordings of their phone) and a dated list of everything the household watched. The repository's own comment establishes that backups are in scope — store.ts:38-42 moved the bearer token to the keychain specifically 'rather than AsyncStorage, which is a plain file that device backups include' — but only the token was moved; the recordings and the watch history, which are the more sensitive of the two, were left where they are. The README's privacy claim ('Every clip is deleted from the server as soon as it has been analysed') and the in-app camera rationale ('Nothing is stored after it's identified') say nothing about the local copies.

**Evidence.**

apps/mobile/src/queue.ts:44-48:
```
function pendingDir(): Directory {
  const dir = new Directory(Paths.document, QUEUE_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}
```
and :101-104 `const source_ = new File(clipUri); ... await source_.move(target);` — no backup-exclusion call anywhere in the repo (`grep -rn "ExcludedFromBackup\|allowBackup\|backupRules" apps/mobile` returns nothing).

node_modules/expo-modules-core/ios/FileSystemUtilities/FileSystemManager.swift:37-38:
```
let documentPaths = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)
self.documentDirectory = documentPaths[0]
```

node_modules/@expo/config-plugins/build/android/AllowBackup.js:
```
function getAllowBackup(config) {
  // Defaults to true.
  return config.android?.allowBackup ?? true;
}
```
apps/mobile/app.json has no `android.allowBackup` key, so prebuild writes `android:allowBackup="true"`.

apps/mobile/src/store.ts:35-42 (the stated threat model) and :190-192 `AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(libraryStore.get()))` / :239 the same for history.

**Fix.** Treat the queue directory as cache-that-must-survive rather than as user documents: on iOS set `NSURLIsExcludedFromBackupKey` on `Paths.document/pending-clips` when it is created (expo-file-system exposes this; otherwise a tiny config plugin / native call), and on Android set `"android": { "allowBackup": false }` in app.json, or ship a `data-extraction-rules` / `full-backup-content` resource that excludes `files/pending-clips` and the AsyncStorage database. Add a line to the Settings 'How it works' card and the README saying what stays on the device and for how long, so the privacy copy matches the behaviour. Add an assertion to app-config.test.ts pinning whichever choice is made, the way the cleartext policy is pinned.


### L3-6 · low — The bearer token moved into the keychain to keep it out of backups is stored with the default WHEN_UNLOCKED accessibility, which is backup-eligible and migrates to a restored device

`apps/mobile/src/store.ts`:173 · CWE-522 · reasoned

**Who.** Whoever can restore or read an encrypted iOS backup — someone with the user's Apple ID and a new device, or the backup password plus a copy of a local Finder backup.

**How.** 1. `writeToken` calls `SecureStore.setItemAsync(TOKEN_KEY, token)` with no options. 2. expo-secure-store's iOS default is `keychainAccessible: .whenUnlocked`, which maps to `kSecAttrAccessibleWhenUnlocked`. 3. Unlike the `*_THIS_DEVICE_ONLY` variants, that class is included in encrypted iTunes/iCloud backups and is restored onto a different device. 4. The token therefore leaves the device with the backup and arrives on whatever device the backup is restored to.

**Why it matters.** The bearer token is the shared secret that authorises spending the operator's Claude budget — the thing APP_TOKEN exists to protect. The code and the README both claim the keychain move solves the backup problem ('the keychain rather than AsyncStorage, which is a plain file that device backups include'; 'The app keeps the access token in the device keychain (expo-secure-store), not in plain app storage'). It does solve the plain-file problem, but not the backup problem it names: the item is still in the backup, just encrypted with the backup rather than left in the clear. On Android the equivalent is fine — SecureStore keeps ciphertext in SharedPreferences and the AES key in the AndroidKeyStore, which is not backed up — so this is an iOS-only gap and easy to close. MISS-3 in REVIEW.md fixed the adjacent problem (the leftover AsyncStorage copy) and is genuinely fixed at store.ts:99-106; this is a different hole in the same mitigation.

**Evidence.**

apps/mobile/src/store.ts:171-178:
```
async function writeToken(token: string): Promise<void> {
  try {
    if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
```
(and :160 `await SecureStore.setItemAsync(TOKEN_KEY, legacy);` in the migration) — neither call passes a `SecureStoreOptions`.

node_modules/expo-secure-store/ios/SecureStoreOptions.swift:
```
@Field
var keychainAccessible: SecureStoreAccessible = .whenUnlocked
```
node_modules/expo-secure-store/ios/SecureStoreModule.swift:193-208 maps `.whenUnlocked` to `kSecAttrAccessibleWhenUnlocked` and `.whenUnlockedThisDeviceOnly` to `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
node_modules/expo-secure-store/build/SecureStore.d.ts:36-39:
```
 * Similar to `WHEN_UNLOCKED`, except the entry is not migrated to a new device when restoring from
...
export declare const WHEN_UNLOCKED_THIS_DEVICE_ONLY: KeychainAccessibilityConstant;
```
— i.e. the default IS migrated.

**Fix.** Pass an explicit accessibility class on both writes and the read: `SecureStore.setItemAsync(TOKEN_KEY, token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY })` (and the same option object on `getItemAsync`/`deleteItemAsync` so the item is found under the same service). The token is re-entered in Settings on a new device anyway, so nothing is lost by not migrating it. Update the comment at store.ts:38-42 and the README bullet to say what the keychain now guarantees.


### L3-7 · low — The server process still binds 0.0.0.0 with no way to change it; SEC-1's fix bound only the published Docker port, not the listener the README's first quickstart starts

`apps/server/src/index.ts`:532 · CWE-1327 · reproduced

**Who.** Anyone on the same network as a machine running `npm run server` — a café or hotel Wi-Fi, a co-working LAN, a shared office subnet — which is the normal way this server is run during development and the first command the README gives.

**How.** 1. The operator follows the README: `npm install; cp .env.example .env; npm run server  # http://localhost:8787`. 2. `serve({ fetch: app.fetch, port: config.port })` passes no `hostname`, so `@hono/node-server` calls `server.listen(port, undefined)` and Node binds every interface. There is no HOST/BIND environment variable to narrow it. 3. Anyone on the subnet scans for 8787, finds an unauthenticated server (APP_TOKEN unset by default, DAILY_CLIP_LIMIT 0 = off) and starts uploading clips, or reads back `GET /sessions/:id` for any session id they can obtain.

**Why it matters.** Unmetered access to the operator's Claude budget and to what the household watched, on any network the laptop joins. The README labels this command `http://localhost:8787`, which is not what it does. REVIEW.md's SEC-1 named three things — 'APP_TOKEN is unset by default, DAILY_CLIP_LIMIT defaults to 0 (off), and the server binds 0.0.0.0' — and is listed as fixed; the commit ('Bind the server to loopback') changed docker-compose.yml's published port and added deploy.test.ts, which asserts only about the compose file. The listener itself was not touched, and the startup banner still prints the 0.0.0.0 address. On a home LAN this is the intended behaviour (the phone has to reach it), so the fix is a configurable bind, not a hard-coded loopback.

**Evidence.**

apps/server/src/index.ts:532-534:
```
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[server] listening on http://0.0.0.0:${info.port}`);
  });
```
apps/server/src/config.ts has `port` but no host/bind key; `grep -rn "hostname\|HOST" apps/server/src` finds nothing.
node_modules/@hono/node-server/dist/index.mjs:651 / dist/server.js:686 `server.listen(options?.port ?? 3e3, options.hostname, ...)` — `options.hostname` is undefined here, so Node binds all interfaces.

Observed directly while running the PoC for L3-3: starting a second instance on the same port produced
```
Error: listen EADDRINUSE: address already in use 0.0.0.0:8899
    at serve (file:///home/user/tvsham/node_modules/@hono/node-server/dist/index.mjs:651:10)
    at main (/home/user/tvsham/apps/server/src/index.ts:532:3)
```
which names the bound address as 0.0.0.0, not 127.0.0.1.

deploy.test.ts only reads docker-compose.yml; README.md:51 says `npm run server   # http://localhost:8787`.

**Fix.** Add a `HOST` setting (`host: env("HOST", "127.0.0.1")` in config.ts, passed as `serve({ fetch, port, hostname: config.host })`) and print the address actually bound rather than a hard-coded `0.0.0.0`. Default it to loopback so `npm run server` matches what the README says, and document `HOST=0.0.0.0` alongside the existing advice to set APP_TOKEN before widening — which is exactly the shape the compose file already takes. Extend deploy.test.ts (or index.test.ts) to assert the default host is loopback, so this cannot silently regress the way it did.


### L3-8 · info — The container that decodes attacker-supplied video keeps the full default capability set, a writable root filesystem and no-new-privileges off

`docker-compose.yml`:24 · CWE-250 · reasoned

**Who.** Whoever uploads a clip — the same unauthenticated caller as everywhere else — in the event of a memory-corruption bug in one of the ffmpeg demuxers or decoders the server hands their bytes to. This is defence in depth, conditional on a third-party vulnerability rather than on a defect in this code.

**How.** 1. Upload a crafted container that reaches ffmpeg (the format whitelist restricts it to mov/mp4/m4a/3gp/3g2/mj2/matroska/webm/avi/mpegts, all of which are large, historically bug-prone parsers). 2. Obtain code execution inside the container as the `node` user. 3. From there: the root filesystem is writable, so the compiled server in `/app/apps/server/dist` can be rewritten and will run on the next restart (`restart: unless-stopped`); `no-new-privileges` is not set, so any setuid binary in the `node:22-slim` base can be used to escalate inside the container; the default Docker capability set (CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, NET_RAW, ...) is retained even though the process needs none of them; and `curl` was added to the image for the HEALTHCHECK, which hands the attacker a ready-made exfiltration tool next to the ANTHROPIC_API_KEY sitting in the process environment.

**Why it matters.** Turns a hypothetical ffmpeg RCE into persistence and an easier escalation path, in the one component the repository's own documentation identifies as the attacker-driven surface ('Decoding is bounded... a container that decodes attacker-supplied video'). The compose file already reasons carefully about port publishing and memory but stops there.

**Evidence.**

docker-compose.yml has `mem_limit: 2g` and `restart: unless-stopped` and nothing else: no `read_only`, `tmpfs`, `cap_drop`, `security_opt`, `pids_limit` or `cpus`.
apps/server/Dockerfile:21 `RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl && ...` — curl ships in the runtime image purely for :35-36 `HEALTHCHECK ... CMD curl -fsS "http://127.0.0.1:${PORT}/health"`.
apps/server/Dockerfile:32-33 `RUN mkdir -p /tmp/tvsham && chown node:node /tmp/tvsham` / `USER node` — the unprivileged user is set, which is the half that is already right.
docker-compose.yml:15-16 `env_file: - apps/server/.env` puts ANTHROPIC_API_KEY in the process environment.

**Fix.** Add to the `server` service: `read_only: true` with `tmpfs: [/tmp]` (TMP_DIR is already /tmp/tvsham, so nothing else needs to be writable), `cap_drop: [ALL]`, `security_opt: ["no-new-privileges:true"]`, and `pids_limit: 256`. Replace the curl HEALTHCHECK with `node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"` and drop curl from the runtime `apt-get install`, so the image ships nothing that is not needed to run the server. Pin the base image by digest while you are there.


## Checked and sound

What the reviewers tried and could not break. Recorded so it is not re-raised, and so a future change that undoes one of these is recognisable as a regression.

- Prototype pollution via multipart: the route calls c.req.parseBody() with no options, so hono's dot/all handling (the only path touching __proto__/nested keys) never runs; only the literal keys `clip` and `clipKey` are read. No pollution.
- Path traversal via upload filename: safeExtension() runs path.extname on the attacker name and only keeps a value in ALLOWED_EXTENSIONS (else .mp4); extname cannot yield a slash, and the clip path is path.join(workDir, 'clip'+ext) with workDir keyed on a randomUUID session id and a numeric clip index. Verified traversal names ('../../etc/passwd') collapse to .mp4 (index.test.ts:114).
- ffmpeg concat/local-file read (prior MISS-4): -format_whitelist now excludes concat, and I confirmed the whitelist contains only mov/mp4/m4a/3gp/3g2/mj2/matroska/webm/avi/mpegts; a `ffconcat` file named clip.mp4 probes as width 0 and assertDecodable rejects it (media.test.ts:101). mp4 external data references (dref) are off by default in this ffmpeg build (-enable_drefs default false).
- Model-supplied URLs as sinks: youtubeUrlOrNull and platformVideoLink parse with new URL(), require https:, and match the host against an anchored per-platform regex; youtubeId extracts an 11-char id and the watch URL is rebuilt canonically; creator handles must match /^[A-Za-z0-9._-]{2,50}$/. The app never opens identification.videoUrl/youtubeUrl directly (only server-built result.links), and every open site (openLink, WatchRow, CastStrip, alternatives) gates on isSafeWebUrl (http/https only) and images on safeImageUri. No javascript:/intent:/file: reaches Linking.openURL.
- SSRF via outbound calls: every getJson/postForm target host is fixed (wikipedia lang and STT url from operator config, youtube/tmdb hardcoded); model text only fills encodeURIComponent path/query segments, never the host. No attacker-chosen host reaches fetch.
- Hostile server response to the app: cleanRecognitionResult/cleanSavedItems/cleanQueuedClips coerce every field (oneOf whitelists, bounded strings via MAX_TEXT=2000, MAX_ITEMS=100 for network lists), numbers are Number.isFinite-checked and clamped, and React Native <Text> does not interpret markup, so a MITM on the cleartext LAN hop cannot inject a scheme (checked at open time) or a code sink. The saved-library ceiling reasoning (storedItems keeps the app's own list whole, network lists capped) is sound.
- ReDoS: the regexes over untrusted/model text (youtubeId, probe's `/Video:.*?,\s*(\d{2,6})x(\d{2,6})/` per line, ipv6Groups, cleanClipKey, cleanRegion, cleanHint) are all anchored or bounded with no nested unbounded quantifiers; probe input (an IP or a bounded ffmpeg banner line) and clip keys are length-limited.
- Session id as a capability: ids are crypto.randomUUID, GET/DELETE /sessions/:id look up an exact map key, and sessions are swept on both idle TTL and an absolute max age (so polling cannot pin a slot). No id is interpolated into a filesystem or shell sink.
- Body-size limits: bodyLimit runs before parseBody for both /sessions (4 KB) and clips (maxUploadBytes), and rejects chunked bodies by streaming-and-counting, so content-length spoofing is covered; uploadsInFlight is counted before parseBody and released in finally (index.test.ts:333).
- execFile process spawning: every ffmpeg call is execFile with an argument array (no shell), -nostdin, -protocol_whitelist file, a timeout with killSignal SIGKILL, and maxBuffer on run(); no attacker string reaches a shell.
- clipKey/hint/region normalisation: clipKey matched against /^[A-Za-z0-9:_-]{1,128}$/ and only ever compared (never interpolated); hint collapsed to one <=120-char line and fenced with a per-request randomUUID before the model; region validated to two letters and only used as a map key.
- Session id generation and guessability: sessions.ts:39 uses node:crypto randomUUID (v4, 122 bits from the CSPRNG); ids are never derived from a counter, a timestamp or anything the client sends, GET /sessions/<garbage> returns a flat 404, and DELETE returns 204 whether or not the session existed, so there is no existence oracle and no enumeration path. The only leak of an id is the request log (reported as L2-3).
- The bearer gate cannot be routed around. I probed /HEALTH, /health/, //health, /health/../sessions, /sessions/../health, /sessions/x/../../health, /%68ealth, /sessions;/health, /health%00/sessions, /sessions#/health and /sessions?/health against the real app with APP_TOKEN set: everything that reaches a /sessions handler gets 401, and the two cases that return 200 (/%68ealth, /sessions/../health) are genuinely the health route because the gate and the router both read the same normalised c.req.path. Hono's getPath percent-decodes and the Request constructor resolves '..' before either sees the value, so they cannot disagree.
- tokenMatches (index.ts:122-127) is a real constant-time compare: Buffer.from on both sides, an explicit length equality before timingSafeEqual (which throws on unequal lengths), and a `startsWith("Bearer ")` prefix check that fails closed for any other scheme spelling. The length pre-check leaks only the token's length, which is not useful against a high-entropy secret.
- The daily cap cannot be bypassed from inside a session. usage.take() is the only mutation of the quota and it sits inside the s.busy chain (index.ts:271-288) alongside the duplicate-clipKey check and the MAX_CLIPS_PER_SESSION check, after parseBody and before s.analysing++, so two concurrent uploads for one session serialise rather than both passing an entry check; the entry-level usage.remaining() check at line 240 only refuses early and never spends a unit; a duplicate clipKey short-circuits (lines 222-234 and 272) without spending one; and a clip refused by the ffmpeg budget has still spent its unit, which is the conservative direction. s.busy is reassigned synchronously in the same turn the chain is built, so there is no window for a second upload to read a stale tail.
- The app's token-withholding gate (settings.ts:80-89) holds against URL-parser confusion. I ran 32 hostile server URLs through canSendTokenTo: userinfo tricks (http://10.0.0.1@evil.com, http://user@10.0.0.1@evil.com), fragment tricks (http://evil.com#10.0.0.1), suffix tricks (http://10.0.0.1.evil.com), path tricks (http://evil.com/10.0.0.1), backslash tricks (http://ev.il\@10.0.0.1), IPv4-mapped IPv6 (http://[::ffff:10.0.0.1]), out-of-range private ranges (172.32.0.1, 100.128.0.1) and non-web schemes all withhold the token; octal (http://010.0.0.1) is normalised by the URL parser to the public 8.0.0.1 and correctly withholds. Every mismatch I could construct failed in the safe direction. The one structural note is that cleanServerUrl returns the raw trimmed string rather than url.href, so the security decision is made on the parsed view while fetch re-parses the raw text — in Node the two agree on every case I tried, and I had no device on which to prove OkHttp/NSURLSession disagree, so I am not claiming a finding.
- No deep link can reach the credentials. The app declares the tvsham:// scheme (app.json) but not one route uses useLocalSearchParams or reads a link parameter — grepped every .ts/.tsx under apps/mobile/app and apps/mobile/src — so a link can open a screen and nothing more; the server URL and token are only settable from the Settings form.
- The keychain migration finishes. readToken (store.ts:155-169) only reports migrated:true after SecureStore.setItemAsync has resolved, hydrate then calls persistSettings immediately (store.ts:106), and persistSettings writes `{ ...rest, token: "" }` (store.ts:142), so the plaintext copy in AsyncStorage is actually overwritten rather than merely shadowed — REVIEW.md's MISS-3 is genuinely closed. A device whose keychain throws keeps the legacy copy, which is the deliberate fail-open for usability and is documented as such.
- No secret reaches an error body or a log. The Anthropic key lives only in the SDK client (recognize.ts:9); the TMDB and YouTube keys are put in query strings (tmdb.ts:43, resolve.ts:87) but every one of those calls goes through getJson, which swallows the error without printing the URL (http.ts:43-45); the STT key is an Authorization header on postForm, and fetch strips Authorization across a cross-origin redirect; clientErrorMessage (index.ts:472-475) returns a fixed string unless NODE_ENV is literally 'development'; and grepping the app for console.* found nothing that prints settings or the token.
- Prototype pollution through the settings record is not reachable: sanitise (settings.ts:107-117) builds a fresh object literal with exactly five known keys, so any extra key from the stored JSON — including an own '__proto__' data property, which is what JSON.parse produces — is dropped rather than spread onward. The region key that indexes TMDB's results object is constrained to two letters by cleanRegion (index.ts:447-449).
- /health does not become a work amplifier: ffmpegBinary() memoises its result in a module-level variable including the null case (media.ts:9-32), so flooding the unauthenticated health route does not spawn a process per request.
- The IPv6 /64 bucketing in addressBucket is correct for what it claims: two spellings of one address, a zone id, and a mapped IPv4 all collapse to the right bucket, and the neighbouring /64 does not collide (verified against the existing tests plus my own calls). A client with a routed /56 or /48 still has 256-65536 buckets to rotate through, which the code's own comment acknowledges as an accepted trade-off rather than a claim of completeness; I am recording it rather than reporting it.
- A malicious web page cannot make the server spend money even with no APP_TOKEN. It can create a session with a preflight-free POST, but the reply carries no CORS headers so the page cannot read the sessionId, POST /sessions/:id/clips needs that id, and DELETE is not a CORS-simple method so it preflights and fails. The resulting exposure is denial of service only, which is what L2-2 reports.
- ffmpeg input guards: I built `printf 'ffconcat version 1.0\nfile /etc/hostname\n' > evil.mp4` and ran the exact INPUT_GUARDS argument list from media.ts against the bundled ffmpeg 7.0.2. Output: `[concat @ ...] Format not on whitelist 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts'` — the demuxer is refused before it can name a local file. Without `-format_whitelist` the same input reaches the concat demuxer and is stopped only by ffmpeg's own `Unsafe file name` check, so MISS-4's fix is doing real work. I also checked the remaining whitelisted demuxer that can reference external data: `ffmpeg -h demuxer=mov` reports `-enable_drefs <boolean> ... (default false)`, so mp4/mov external track references are off. No SSRF or local-file read via the upload.
- Bearer gate ordering: the auth middleware is registered at index.ts:130, before both bodyLimit registrations, and I verified with a stream body that a request without an Authorization header is refused after 1 MB rather than draining (`APP_TOKEN set, no Authorization -> HTTP 401; MB read off the wire = 1`). The /health exemption is an exact path match (`c.req.path === "/health"`), which fails closed for anything else. `tokenMatches` compares with `timingSafeEqual` after a length check.
- Deep links: the app registers `scheme: "tvsham"` and expo-router auto-exposes /index, /result, /library and /settings, but `grep -rn "useLocalSearchParams|useGlobalSearchParams|Linking.getInitialURL|addEventListener(\"url\"" apps/mobile` returns nothing — no screen reads a route parameter, and every screen renders from the in-memory store or AsyncStorage. The only thing another app or a web page can do with a tvsham:// URL is bring TVsham to the foreground on one of four screens. `expo-linking` is present only as an expo-router transitive dependency and is never imported by first-party code.
- Outbound URL construction: every third-party call is built against a fixed host with `new URL` + `searchParams.set` or `encodeURIComponent` (resolve.ts wikipedia/oembed/googleapis, tmdb.ts api()), model-supplied YouTube URLs are reduced to an 11-character id and the link rebuilt canonically, `youtubeUrlOrNull` (SEC-5's fix) parses the hostname with an anchored regex rather than a substring, and `platformVideoLink` requires https: plus a hostname matching `(^|\.)tiktok\.com$` / `(^|\.)instagram\.com$`. I could not construct a model output that reaches an attacker-chosen host. The only operator-interpolated hostname is `https://${WIKIPEDIA_LANG}.wikipedia.org`, which is not caller-controlled.
- Link handling in the app: every URL that reaches `Linking.openURL`, `WebBrowser.openBrowserAsync` or an `<Image source>` passes `isSafeWebUrl`/`safeImageUri` first — I traced all nine call sites (results.tsx:14/22/35-36/66/71/95/99, result.tsx:28/52-53, library.tsx:13/29) and found no bypass, so an on-path attacker cannot reach `intent://`, `file://` or a custom scheme through a rewritten response.
- Upload admission for a normal Content-Length upload: bodyLimit short-circuits on the header, the handler's `uploadsInFlight` gate runs before `parseBody`, the counter is released in a `finally`, and the quota/clip-cap/duplicate checks are all inside the `s.busy` chain rather than at request entry. The failure is specific to bodies with no Content-Length (L3-1) and to bodies that arrive slowly (L3-3); I tried and could not break the Content-Length path.
- Temporary files: work directories are `path.join(config.tmpDir, "<uuid>-<n>")` with a UUID session id, removed in a `finally`, wiped wholesale at startup and swept by mtime every 60 s (BUG-4's fix). `safeExtension` maps anything outside a six-entry allowlist to `.mp4`, and I confirmed `safeExtension("../../etc/passwd") === ".mp4"`. Nothing under tmpDir is ever served back over HTTP — the server has no static file route at all.
- Image contents: the runtime stage copies only package.json, pruned production node_modules, packages/shared and apps/server/dist. apps/server/tsconfig.json sets `"exclude": ["src/**/*.test.ts"]` and no `sourceMap`, so no test code and no source maps ship. .dockerignore keeps `**/.env`, `apps/server/tmp` and `apps/server/eval-clips` out of every layer, and I verified no .env and no recordings exist in the working tree. `--ignore-scripts` on the single `npm ci` means ffmpeg-static's downloader never runs, so the image relies on the apt ffmpeg as intended.
- Android permissions: the merged manifest gets CAMERA, RECORD_AUDIO and READ_MEDIA_VIDEO from app.json, VIBRATE from expo-haptics, INTERNET from expo-file-system, and READ/WRITE_EXTERNAL_STORAGE only with `android:maxSdkVersion="32"` from expo-image-picker and expo-file-system. Nothing pulls in READ_MEDIA_IMAGES or READ_MEDIA_AUDIO, so the photo picker cannot reach the user's images. Both library FileProviders and expo-image-picker's cropper activity are declared `android:exported="false"` upstream.
- The IPv6 /64 bucketing added for MISS-2 is correct on the inputs I threw at it: `2001:db8:abcd:1234::1`, the fully expanded form, a form with a zone id and a form with all eight groups all collapse to one bucket; the neighbouring /64 does not; and `::ffff:203.0.113.7` correctly decodes to the IPv4 address rather than being billed as a /64 (which would have put every IPv4 client in one bucket). The `%zone` strip and the embedded-dotted-quad handling both behave.
- Response coercion on the app side (SEC-8's fix, shapes.ts) is thorough: every array is capped at MAX_ITEMS except the app's own stored library, every enum goes through `oneOf` with a fallback, numbers are range-clamped with `Number.isFinite` guards, and `storedItems` deliberately does not apply the network ceiling to the saved library — the reasoning in the comment matches the code and matches the last commit in the log.
- Server session ids are `crypto.randomUUID()`, swept on both an idle TTL and an absolute `SESSION_MAX_AGE_MS` (so the poll-to-keep-alive hold that MISS-1 described is closed), and bounded per caller as well as globally. I confirmed the per-caller refusal path returns 503 with `Retry-After: 60` and that a different owner is unaffected.
- No CORS headers are emitted unless CORS_ORIGIN is set, there is no static file serving, no cookies, no browser front end, and nothing in the app or server uses eval/Function/WebView/dangerouslySetInnerHTML (`grep -rn "WebView|dangerouslySetInnerHTML|eval\(|Function\(" apps/mobile` finds only two `require()` calls inside a test).

