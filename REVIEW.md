# TVsham — security & upgrade review (2026-09-09)

Two independent reviewers read every first-party file in this repository; a third then re-read each security or bug claim against the code and tried to refute it. Only claims that survived that check are listed as findings; the ones that did not are recorded at the end so they are not re-raised.

## Status — what has been fixed

All of the following are fixed on `claude/repo-review-security-baiyud`, each with a regression test that was checked by reverting the fix.

**First pass** — every critical and high finding, plus the medium ones that were quick:

`SEC-1`, `BUG-1`, `BUG-3`, `MISS-1`, `MISS-2`

**Second pass** — the remaining medium findings and the low-severity ones that were trivial or small:

`SEC-2`, `SEC-6`, `SEC-8`, `BUG-5`, `MISS-3`, `MISS-4`, `SEC-3`, `SEC-4`, `SEC-5`, `BUG-2`, `BUG-4`, `BUG-6`

Deliberately not done: `SEC-7`, `CI-1`. Each was either already covered by an earlier pass, or judged churn or too risky to make without a device or a measurement. The reasoning is in the commit that touched it.

An independent reviewer then read each commit and tried to find what was wrong with it, and a second reviewer tried to refute every objection raised. What survived that was fixed in a follow-up commit.

Repository hardening applied here as well: every GitHub Action is pinned to a commit rather than a floating tag, each workflow declares a least-privilege `permissions` block, and a Dependabot config, a licence and a security policy are in place.

The rest of this document is the review as written. Fixed items are left in place so the reasoning behind each change stays with it.

## Summary

TVsham is a 'Shazam for video' monorepo: an Expo SDK 57 / React Native 0.86 app (expo-router, expo-camera, expo-image-picker) records 8 s clips or takes a screen recording and uploads it to a self-hosted Node 22 + Hono server that extracts frames/audio with ffmpeg, asks claude-opus-5 (adaptive thinking, web_search_20260209, then a messages.parse structured extraction) and verifies the answer against Wikipedia, YouTube oEmbed and TMDB. For a 33-commit solo side project it is unusually mature: strict TypeScript with noUncheckedIndexedAccess, node:test suites on both sides (not vitest) including an end-to-end ffmpeg pipeline test and a WCAG contrast audit, an eval harness with a calibration comparison, and documented security invariants. The headline gaps are (1) cost is still unmeasured: response.usage is never read, and a per-clip frame-count sentence at the top of the prompt defeats prompt caching across the 2-4 clips of a session, while the README steers toward a Sonnet cascade before the cheaper single-model/lower-effort option has been measured; (2) production builds cannot actually reach the LAN server the README describes, because Android release builds block cleartext HTTP and iOS ATS blocks it unless app.json opts in; (3) the Docker image runs the server against TypeScript source in packages/shared and silently depends on Node >=22.18 type stripping while engines claims >=20 (Node 20 is EOL); (4) repo hygiene: no LICENSE (which contradicts a self-host product), no SECURITY.md, no Dependabot, unpinned actions, an npm ci||npm install fallback, no lint on the server; and (5) a handful of concrete accessibility bugs (no reduced-motion handling; Watched chip and YouTube/Instagram badges fail AA in light mode) that the existing palette test does not cover.

## Attack surface

Two very different surfaces. The server (apps/server) is a self-hosted Node/Hono HTTP API with four routes (/health, POST /sessions, POST /sessions/:id/clips, GET|DELETE /sessions/:id) that accepts attacker-supplied video, decodes it with ffmpeg, and spends real Anthropic API money on every clip; bearer auth (APP_TOKEN) and the daily cap (DAILY_CLIP_LIMIT) are both OFF by default and the server binds 0.0.0.0, so the primary risk is an unauthenticated stranger burning the operator's API budget or wedging the process. Untrusted inputs there are the uploaded container (fed to ffmpeg), the multipart filename, the clip key, the optional hint, the region, and — indirectly — everything visible on the user's TV, which reaches Claude as images and can attempt prompt injection. Outbound, the server calls Anthropic, Wikipedia, YouTube oEmbed/Data API, TMDB and an optional STT endpoint, and the URLs it builds from model output are the SSRF/open-redirect surface. The mobile app (apps/mobile) has no server of its own: it holds a camera/mic permission, an access token in the keychain, a plaintext AsyncStorage library of what the household watched, a queue of unsent video files on disk, and a tvsham:// deep-link scheme via expo-router. Its untrusted input is the server response itself, which by default arrives over cleartext HTTP on a shared LAN and drives URLs handed to Linking.openURL and to <Image>. No cookies, no CSRF surface, no web front end.

## Already done well

- Billing identity comes from the socket address and only honours X-Forwarded-For under TRUST_PROXY (apps/server/src/index.ts:43-57), with a test asserting that no client-controlled header can move the bucket (apps/server/src/index.test.ts:163-173).
- The daily quota, the per-session clip cap and duplicate detection are all re-checked inside the per-session s.busy chain rather than at request entry, so concurrent uploads cannot all pass one entry check (apps/server/src/index.ts:173-190).
- Every ffmpeg invocation uses execFile with an argument array (no shell), -protocol_whitelist file, -nostdin, a hard timeout with killSignal SIGKILL, and a pre-decode pixel/duration/cover-art budget parsed from ffmpeg's own banner (apps/server/src/media.ts:36-45, 52, 71-151); each guard has a test (apps/server/src/media.test.ts:122-190), including 'refuses a file it could not read at all, rather than falling through'.
- All frames come out of one ffmpeg run rather than one spawn per frame, with the measurement recorded in the comment (apps/server/src/media.ts:159-201).
- Untrusted text is fenced with a per-request randomUUID delimiter and explicitly labelled as data, for the transcript, the user hint and the model's own write-up (apps/server/src/recognize.ts:104-120, 180-192), backed by a system-prompt rule that on-screen text is evidence and never instructions (apps/server/src/recognize.ts:38).
- Model-produced URLs are never used verbatim as links: YouTube URLs are reduced to an 11-character id and the link is rebuilt canonically (apps/server/src/resolve.ts:54-77), platform URLs must parse as https with a hostname matching the claimed platform (apps/server/src/resolve.ts:150-170), handles must match a strict character class (apps/server/src/resolve.ts:173-196), and search fallbacks are built with encodeURIComponent.
- The app refuses any non-http(s) URL before handing it to Linking.openURL, WebBrowser or an <Image> source (apps/mobile/src/format.ts:65-77; apps/mobile/src/results.tsx:13-23, 66, 95), and every opening call site goes through it; tests cover intent:// and friends (apps/mobile/src/format.test.ts:69-95).
- Body limits are registered for every route that has a body and run before parsing, and the multipart filename is reduced to an allowlisted video extension (apps/server/src/index.ts:81-91, 360-366) with a traversal test (apps/server/src/index.test.ts:110-116).
- The server access token is stored in the device keychain via expo-secure-store, with a migration for one left in AsyncStorage by an older build (apps/mobile/src/store.ts:128-152).
- Internal error details are only echoed to the client when NODE_ENV is explicitly 'development' (apps/server/src/index.ts:368-377).
- CORS headers are opt-in via CORS_ORIGIN rather than permissive by default (apps/server/src/index.ts:59-62).
- The Docker image runs as the unprivileged node user and has a HEALTHCHECK, and .dockerignore keeps .env files and eval clips out of every layer (apps/server/Dockerfile:16-21; .dockerignore:1-6).
- Session ids are crypto randomUUIDs and sessions are swept on a TTL, so the id is a real capability rather than a guessable handle (apps/server/src/sessions.ts:26-62).
- The identification loop is isolated from React with injected IO and is directly tested, including cancellation and 'never re-sends a clip that was already analysed' (apps/mobile/src/identify-run.ts; apps/mobile/src/identify-run.test.ts).

## Findings (20)

| # | Severity | Category | Title | Where | Effort | Status |
|---|---|---|---|---|---|---|
| SEC-1 | Medium | security | Server is unauthenticated, uncapped and world-published by default; docker-compose contradicts the README's own deployment advice | `docker-compose.yml:6` | small | confirmed |
| SEC-2 | Medium | security | Uploads are fully buffered in memory before any concurrency control, and the work queue is unbounded | `apps/server/src/index.ts:161` | medium | confirmed |
| BUG-1 | Medium | bug | Cancel then restart resurrects the previous run: it keeps writing state and can navigate to the old session's answer | `apps/mobile/src/useIdentify.ts:39` | small | confirmed |
| BUG-3 | Medium | security | Cleartext HTTP is the default transport for clips, the bearer token and every result, with no scheme validation and no declared cleartext policy | `apps/mobile/src/store.ts:51` | small | confirmed |
| MISS-1 | Medium | security | Session slots can be held indefinitely by any unauthenticated caller, denying the service for everyone | `apps/server/src/index.ts:110` | small | found by second reviewer |
| MISS-2 | Medium | security | DAILY_CLIP_LIMIT is keyed on the exact IP, so any IPv6 client resets its quota by rotating source addresses | `apps/server/src/index.ts:43` | small | found by second reviewer |
| SEC-3 | Low | reliability | The speech-to-text request has no timeout and bypasses the injectable fetch wrapper | `apps/server/src/stt.ts:34` | trivial | confirmed, severity lowered |
| SEC-4 | Low | privacy | Enabling speech-to-text silently ships living-room audio to OpenAI because STT_URL defaults to api.openai.com | `apps/server/src/config.ts:33` | trivial | confirmed, severity lowered |
| SEC-5 | Low | security | Model-supplied YouTube URL is validated with an unanchored substring regex | `apps/server/src/recognize.ts:222` | trivial | confirmed |
| SEC-6 | Low | supply-chain | Dockerfile's second npm install undoes --ignore-scripts and the lockfile, and dev dependencies ship in the runtime image | `apps/server/Dockerfile:10` | small | confirmed, severity lowered |
| CI-1 | Low | ci-cd | CI actions are unpinned, the workflow has no permissions block, and `npm ci \|\| npm install` hides a broken lockfile | `.github/workflows/ci.yml:19` | trivial | confirmed, severity lowered |
| SEC-7 | Low | supply-chain | decode-uri-component DoS is reachable at runtime through expo-router deep links | `apps/mobile/package.json:28` | small | confirmed |
| BUG-2 | Low | bug | The look-ahead recording promise is created without a catch, so a rejection after the loop ends is unhandled | `apps/mobile/src/identify-run.ts:109` | trivial | confirmed |
| SEC-8 | Low | security | Server responses are cast, never validated, although they arrive over cleartext HTTP | `apps/mobile/src/api.ts:54` | small | confirmed |
| BUG-4 | Low | privacy | TMP_DIR is never swept, so a crash leaves uploaded clips on disk indefinitely | `apps/server/src/index.ts:380` | trivial | confirmed |
| BUG-5 | Low | bug | Persisted library and history are restored with no shape check beyond Array.isArray | `apps/mobile/src/store.ts:99` | small | confirmed |
| BUG-6 | Low | reliability | Session creation, polling and teardown have no request timeout | `apps/mobile/src/api.ts:75` | trivial | confirmed |
| MISS-3 | Low | security | The keychain migration copies the bearer token out of AsyncStorage but never removes the plaintext copy | `apps/mobile/src/store.ts:129` | small | found by second reviewer |
| MISS-4 | Low | security | ffmpeg input is protocol-restricted but not demuxer-restricted, and the comment claims otherwise | `apps/server/src/media.ts:47` | small | found by second reviewer |
| SEC-9 | Info | security | /health stays unauthenticated when APP_TOKEN is set and discloses the server's configuration | `apps/server/src/index.ts:73` | trivial | confirmed |

### SEC-1 · Server is unauthenticated, uncapped and world-published by default; docker-compose contradicts the README's own deployment advice

**Severity:** Medium · **Category:** security · **Effort:** small · **Where:** `docker-compose.yml:6`

APP_TOKEN is unset by default, DAILY_CLIP_LIMIT defaults to 0 (off), and the server binds 0.0.0.0. The quickstart the README recommends (`docker compose up --build`) then publishes port 8787 on every interface of the host. On anything but a NAT'd home LAN, anyone who finds the port can create sessions and upload clips, and every clip is a paid Claude request with images and web searches — an open tab on the operator's Anthropic bill — plus GET /sessions/:id returns what the household was watching. The startup warning and the README's 'Deploying safely' section acknowledge this, but the shipped compose file is the configuration those docs warn against.

Evidence:

```
docker-compose.yml:6-7 `ports:\n      - "8787:8787"`; apps/server/src/config.ts:70 `dailyClipLimit: Math.max(0, Math.floor(Number(env("DAILY_CLIP_LIMIT", "0")) || 0))`; apps/server/src/index.ts:385-386 `if (!config.appToken) console.warn("[server] APP_TOKEN is not set: anyone who can reach this port can spend your API budget...")`; apps/server/src/index.ts:391 `listening on http://0.0.0.0:${info.port}`
```

**Recommendation.** As written, plus: bind the published port to loopback in docker-compose (`- "127.0.0.1:8787:8787"`) specifically because Docker's port publishing writes its own iptables DNAT rules and bypasses ufw/firewalld rules the operator thinks are protecting the host.

### SEC-2 · Uploads are fully buffered in memory before any concurrency control, and the work queue is unbounded

**Severity:** Medium · **Category:** security · **Effort:** medium · **Where:** `apps/server/src/index.ts:161`

`c.req.parseBody()` materialises the whole multipart body (up to maxUploadBytes = 80 MB) in the request's own turn, before the request ever reaches the per-session chain or the global Limiter. Nothing caps how many uploads are being buffered at once: an unauthenticated caller can open up to MAX_SESSIONS (500) sessions and push 4 clips each, so hundreds of 80 MB buffers plus an unbounded Limiter queue accumulate in one heap. Sessions independently retain up to 24 decoded JPEG frames each for the 15-minute TTL (500 x 24 x ~100 KB is another gigabyte), and docker-compose sets no memory limit, so the practical outcome is an OOM kill of a small VPS rather than a 503. The limiter only bounds how many clips are *analysed* at once, not how much memory is in flight.

Evidence:

```
apps/server/src/index.ts:161 `const form = await c.req.parseBody();`; apps/server/src/config.ts:49 `maxUploadBytes: 80 * 1024 * 1024`; apps/server/src/config.ts:68 `maxSessions: positiveInt(env("MAX_SESSIONS"), 500)`; apps/server/src/limiter.ts:20 `await new Promise<void>((resolve) => this.queue.push(resolve));` (queue has no ceiling)
```

**Recommendation.** Add a global in-flight admission gate before parseBody — a counter or a second Limiter sized at a small multiple of maxConcurrent, returning 503 with Retry-After when full — and give Limiter a `maxPending` that rejects instead of queueing without bound. Better still, stream the upload straight to `clipPath` (busboy / @fastify/multipart-style streaming, or Hono's stream body) rather than buffering to a File. Add `mem_limit`/`deploy.resources.limits` to docker-compose.yml.

### BUG-1 · Cancel then restart resurrects the previous run: it keeps writing state and can navigate to the old session's answer

**Severity:** Medium · **Category:** bug · **Effort:** small · **Where:** `apps/mobile/src/useIdentify.ts:39`

`cancelled` is one shared ref for all runs. `cancel()` sets it true, but `start()` sets it back to false, and the still-running previous `runIdentification` closure reads that same ref through `isCancelled()`. Meanwhile nothing aborts the in-flight upload — `uploadClip` is passed with no AbortSignal, so the HTTP request continues after cancel. Sequence a user hits easily: tap stop while a clip is uploading (the UI resets to idle), then tap Identify again. The first run's upload eventually resolves, `isCancelled()` now returns false, and it calls `deps.onState(...)` and `deps.onResult(...)` — clobbering the new run's status pill and pushing /result with the *previous* session's identification while the new session is still recording. Both sessions also each spend clips against the server's cap and the operator's API budget.

Evidence:

```
apps/mobile/src/useIdentify.ts:22 `const cancelled = useRef(false);`; :27 `cancelled.current = true;` (in cancel); :39 `cancelled.current = false;` (in start); :53 `isCancelled: () => cancelled.current,`; :44 `uploadClip,` is injected as-is, and apps/mobile/src/identify-run.ts:106 calls it with only `{ clipKey }` — no signal. Guarded returns at apps/mobile/src/identify-run.ts:101, 115, 129, 136 all consult that one boolean.
```

**Recommendation.** Give each run a generation number and compare it rather than a boolean: `const gen = useRef(0); ... start: const mine = ++gen.current; isCancelled: () => gen.current !== mine`. Also hold an AbortController per run, pass `signal` through IdentifyDeps into `uploadClip` (api.ts already accepts `opts.signal`), and abort it in `cancel`.

### BUG-3 · Cleartext HTTP is the default transport for clips, the bearer token and every result, with no scheme validation and no declared cleartext policy

**Severity:** Medium · **Category:** security · **Effort:** small · **Where:** `apps/mobile/src/store.ts:51`

`defaultServerUrl()` pre-fills `http://<metro host>:8787`, the Settings placeholder is `http://192.168.1.20:8787`, and `sanitise` only checks that serverUrl is a string — nothing requires a scheme or warns about http. So by default the app uploads 8-second videos of the user's living room, sends `Authorization: Bearer <APP_TOKEN>` and a stable `X-Device-Id`, and reads back the identification, all in the clear. On shared Wi-Fi (a flat, a hotel, an office) anyone on-path can capture the token and the recordings and can rewrite the links in a response — which is precisely why `isSafeWebUrl` exists (the comment at apps/mobile/src/format.ts:59-64 says so). Separately, app.json declares no NSAppTransportSecurity / usesCleartextTraffic policy, so whether a standalone build can even reach an http:// server depends on whatever the prebuild template happens to default to rather than on anything in this repo; Expo Go relaxes ATS, so this can pass in development and fail on a TestFlight or release build.

Evidence:

```
apps/mobile/src/store.ts:51 `return host ? \`http://${host}:8787\` : "";`; apps/mobile/app/settings.tsx:57 `placeholder="http://192.168.1.20:8787"`; apps/mobile/src/settings.ts:34 `serverUrl: typeof s.serverUrl === "string" ? s.serverUrl : "",`; apps/mobile/src/api.ts:29 `if (token) h.Authorization = \`Bearer ${token}\`;`; README.md:71 "the app talks plain HTTP to whatever URL you give it"
```

**Recommendation.** Validate in `sanitise`: parse with `new URL`, require protocol http:/https: and a non-empty host, else fall back to "". Show a visible warning in Settings when the scheme is http: and the host is not a private/link-local address, and refuse to send the token over http: to a non-private host. Declare the cleartext policy explicitly with expo-build-properties (iOS `NSAppTransportSecurity: { NSAllowsLocalNetworking: true }`, Android `usesCleartextTraffic: true` or a scoped network-security-config) so a device build behaves the same as Expo Go.

### MISS-1 · Session slots can be held indefinitely by any unauthenticated caller, denying the service for everyone

**Severity:** Medium · **Category:** security · **Effort:** small · **Where:** `apps/server/src/index.ts:110`

POST /sessions refuses new sessions once sessionCount() reaches MAX_SESSIONS (500 by default), and the only thing that frees a slot is sweepSessions dropping sessions idle for longer than sessionTtlMs (15 minutes). But getSession refreshes touchedAt on every read, so a caller can keep a session alive forever with a GET /sessions/:id every few minutes. There is no per-caller cap on session creation and sessions are not tied to a caller at all. Roughly 500 tiny POSTs (each capped at a 4 KB body) followed by one cheap GET per session every 15 minutes takes the server permanently to 503 for every legitimate user - no upload bandwidth, no ffmpeg work and no Anthropic spend on the attacker's part, so unlike the budget-burn path there is nothing that makes it expensive to sustain. Default deployment is unauthenticated (SEC-1), which is what makes it reachable.

Evidence:

```
apps/server/src/index.ts:110-113 `if (sessionCount() >= config.maxSessions) { sweepSessions(); if (sessionCount() >= config.maxSessions) return c.json({ error: "server busy, try again shortly" }, 503); }`; apps/server/src/sessions.ts:43-47 `export function getSession(id: string): Session | undefined { const s = sessions.get(id); if (s) s.touchedAt = Date.now(); return s; }`; sessions.ts:53-56 `if (now - s.touchedAt > config.sessionTtlMs)`; apps/server/src/config.ts:68 `maxSessions: positiveInt(env("MAX_SESSIONS"), 500)`
```

**Recommendation.** Bound sessions per caller as well as globally: key a small map on caller(c) and refuse more than a handful of live sessions per address (503 with Retry-After), and expire on createdAt as well as touchedAt so a session cannot be kept alive past an absolute lifetime by polling. Both are a few lines in sessions.ts and reuse the existing caller() identity, which is already the thing a client cannot choose.

### MISS-2 · DAILY_CLIP_LIMIT is keyed on the exact IP, so any IPv6 client resets its quota by rotating source addresses

**Severity:** Medium · **Category:** security · **Effort:** small · **Where:** `apps/server/src/index.ts:43`

caller() returns `ip:<remote address>` verbatim and the usage store buckets on that exact string. The CLAUDE.md invariant it implements - bill by something the caller cannot choose - holds for forgery, but an address is unforgeable and yet not scarce: any client on a normal IPv6 allocation owns a whole /64 and can source each request from a different address, so the daily cap counts one clip per address and never fires. On a dual-stacked public host this defeats the one control the README names as the ceiling for an exposed server ("Set DAILY_CLIP_LIMIT if the server is public... it cannot be reset by rotating an id"), and each free clip is a full Opus request with web search. The usage store's own MAX_TRACKED_CALLERS eviction then quietly discards the stale entries, so nothing even looks anomalous.

Evidence:

```
apps/server/src/index.ts:48-53 `const remote = getConnInfo(c).remote.address; if (remote) return `ip:${remote}`;`; apps/server/src/usage.ts:28-31 `const entry = (caller: string, now: number) => { ... const found = counts.get(caller);` (exact-string bucket); usage.ts:20 `const MAX_TRACKED_CALLERS = 10_000;`; README.md:70 "It counts against the connecting address, never a header the caller sets, so it cannot be reset by rotating an id."
```

**Recommendation.** Normalise the bucket before counting: for an IPv6 remote address, truncate to the /64 (or /56) prefix; for IPv4 keep the full address. A few lines in caller(), plus a test asserting that two addresses in the same /64 share a bucket. Also worth saying in the README that the cap is per address family prefix, not per socket.

### SEC-3 · The speech-to-text request has no timeout and bypasses the injectable fetch wrapper

**Severity:** Low (reported as medium, adjusted after review) · **Category:** reliability · **Effort:** trivial · **Where:** `apps/server/src/stt.ts:34`

Every other outbound call goes through `getJson` with `AbortSignal.timeout(8000)` (apps/server/src/http.ts:12-19), and every ffmpeg run has a hard timeout — but the STT POST calls global `fetch` with no signal, no response-size bound, and not through `http.ts` as CLAUDE.md requires. `transcribe` is awaited inside `processClip`, which runs inside `limiter.run`, so a hung or very slow STT endpoint holds a concurrency slot indefinitely; three of them permanently wedge the server (default MAX_CONCURRENT=3) with no timeout anywhere to break the deadlock, and the client sits on an open connection. This is reachable whenever STT_PROVIDER=whisper-http, including against a self-hosted whisper that has stalled.

Evidence:

```
apps/server/src/stt.ts:34 `const res = await fetch(config.stt.url, { method: "POST", headers, body });`  — compare apps/server/src/http.ts:14-17 `const res = await impl(url, { headers: ..., signal: AbortSignal.timeout(timeoutMs) });`
```

**Recommendation.** Same fix, but note that http.ts's `getJson` cannot host this call as-is (it is a GET returning JSON). Export the injectable `impl` from http.ts (or add a `postForm`/`fetchJson` there) and call it with `signal: AbortSignal.timeout(...)`, keeping the try/catch that returns null so a missing transcript stays a supported outcome.

*Reviewer note (confirmed, severity lowered):* The code claim is exactly right: stt.ts calls global fetch with no signal, no size bound and outside http.ts, which is the only outbound call in the server without a deadline, and it is awaited inside limiter.run so a hung endpoint permanently holds one of MAX_CONCURRENT=3 slots. But the severity is overstated for this app's threat model: the provider defaults to "none" (config.ts:32), so the path does not exist unless the operator opts in, and the endpoint that would hang is one the operator chose and hosts. The attacker-controlled part is bounded too - extractAudio caps the wav at maxClipSeconds (60 s) of 16 kHz mono. It is a real reliability bug and a real violation of the CLAUDE.md convention that outbound network goes through http.ts, but it is not remotely triggerable on a default install.

### SEC-4 · Enabling speech-to-text silently ships living-room audio to OpenAI because STT_URL defaults to api.openai.com

**Severity:** Low (reported as medium, adjusted after review) · **Category:** privacy · **Effort:** trivial · **Where:** `apps/server/src/config.ts:33`

The documented way to turn dialogue on is to set STT_PROVIDER=whisper-http (the .env.example shows exactly that line uncommented first). STT_URL then falls back to https://api.openai.com/v1/audio/transcriptions, so a self-hosted-by-design server starts uploading 60-second recordings of whoever is in the room to a third party the operator never chose, and the app's microphone permission copy ('Nothing is stored after it's identified', apps/mobile/app/index.tsx:238) does not mention it. The whole point of the STT abstraction is that a local whisper.cpp works too; the default should not be the hosted one.

Evidence:

```
apps/server/src/config.ts:31-36 `stt: { provider: env("STT_PROVIDER", "none")!, url: env("STT_URL", "https://api.openai.com/v1/audio/transcriptions")!, ... }`; apps/server/.env.example:45-46 `# STT_PROVIDER=whisper-http` / `# STT_URL=https://api.openai.com/...`
```

**Recommendation.** Default STT_URL to undefined and fail fast at startup when provider is whisper-http without one. Also surface the destination host in /health only behind the token (see SEC-9), and put the third-party destination in the app's microphone rationale text if a hosted STT endpoint is configured.

*Reviewer note (confirmed, severity lowered):* The core claim holds: STT_URL falls back to https://api.openai.com/v1/audio/transcriptions, so an operator who sets only STT_PROVIDER=whisper-http ships living-room audio to OpenAI, and the app's microphone copy does not mention any third party. But the cited evidence is wrong on the point that makes it scary: .env.example does NOT show STT_PROVIDER uncommented - line 45 is `# STT_PROVIDER=whisper-http` and STT_URL is presented immediately beneath it on line 46, so the documented path puts the destination directly in front of the operator. STT is also off by default, and without STT_API_KEY the request is rejected by OpenAI (the audio has still left the machine, so the privacy point stands). Real defaulting mistake, low rather than medium.

### SEC-5 · Model-supplied YouTube URL is validated with an unanchored substring regex

**Severity:** Low · **Category:** security · **Effort:** trivial · **Where:** `apps/server/src/recognize.ts:222`

`toIdentification` keeps `youtubeUrl` whenever the string contains 'youtube.com' or 'youtu.be' anywhere, so `https://phish.example/watch?ref=youtube.com` is accepted and stored on the Identification that is returned to the app and persisted into the device library (SavedItem.identification). This is a model-controlled value and the model reads text off the user's TV screen, which is exactly the prompt-injection channel the system prompt tries to defend. Impact today is limited — the app renders only `result.links`, and `youtubeLinkFromUrl` re-derives an 11-character video id and rebuilds a canonical URL — so nothing currently opens this value. But it is a host check that does not check the host, sitting next to `platformVideoLink` which does it properly, and the only test for it uses vimeo.com, which any substring check would also reject.

Evidence:

```
apps/server/src/recognize.ts:222 `if (o.youtubeUrl && /youtube\.com|youtu\.be/.test(o.youtubeUrl)) id.youtubeUrl = o.youtubeUrl;`; apps/server/src/recognize.test.ts:47 `youtubeUrl: "https://vimeo.com/123"` is the only negative case
```

**Recommendation.** Parse and check the hostname the way platformVideoLink already does: `try { const u = new URL(o.youtubeUrl); if (u.protocol === "https:" && /^(.+\.)?(youtube\.com|youtu\.be)$/.test(u.hostname)) id.youtubeUrl = u.toString(); } catch {}`. Add a test for `https://evil.example/?x=youtube.com`.

### SEC-6 · Dockerfile's second npm install undoes --ignore-scripts and the lockfile, and dev dependencies ship in the runtime image

**Severity:** Low (reported as medium, adjusted after review) · **Category:** supply-chain · **Effort:** small · **Where:** `apps/server/Dockerfile:10`

Line 7 carefully runs `npm ci ... --ignore-scripts`, with a `|| npm install` fallback that already defeats lockfile pinning when ci fails. Line 10 then runs a plain `npm install --include=dev` with scripts enabled, so every dependency and devDependency lifecycle script executes during the build and versions may float away from package-lock.json — the --ignore-scripts on line 7 buys nothing. The final stage copies the whole /app tree, so the production image also carries typescript, tsx, @types/node and the rest of the dev tree alongside the compiled dist, enlarging both the image and the code present in a container that decodes attacker-supplied video.

Evidence:

```
apps/server/Dockerfile:7 `RUN npm ci --workspace apps/server --include-workspace-root --omit=dev --ignore-scripts || npm install --workspace apps/server --omit=dev --ignore-scripts`; apps/server/Dockerfile:10 `RUN npm install --workspace apps/server --include=dev --no-audit --no-fund && npm run build --workspace apps/server`; apps/server/Dockerfile:16 `COPY --from=build --chown=node:node /app /app`
```

**Recommendation.** Drop the `|| npm install` fallback, keep one `npm ci --include-workspace-root --workspace apps/server` (with --ignore-scripts if nothing needs a postinstall - the image apt-installs ffmpeg, so ffmpeg-static's download is dead weight), build, then `npm prune --omit=dev`, and copy only package.json, node_modules, packages/shared and apps/server/dist into the runtime stage.

*Reviewer note (confirmed, severity lowered):* Two of the three claims hold and one is overstated. Holds: line 10's `npm install --include=dev` runs with lifecycle scripts enabled, so the `--ignore-scripts` on line 7 buys nothing (every dependency's postinstall runs during the build - ffmpeg-static's download is one of them, even though the image already apt-installs ffmpeg); and the runtime stage copies the whole /app tree including typescript/tsx/@types, into the container that decodes attacker-supplied video. Overstated: `npm install` with an unchanged package-lock.json installs the locked versions - it re-resolves only where package.json and the lockfile disagree - so "versions may float away from package-lock.json" is not what happens in the normal case. The `|| npm install` fallback on line 7 is the genuine lockfile-bypass. This is build hygiene for a self-hosted image, not a live vulnerability: low.

### CI-1 · CI actions are unpinned, the workflow has no permissions block, and `npm ci || npm install` hides a broken lockfile

**Severity:** Low (reported as medium, adjusted after review) · **Category:** ci-cd · **Effort:** trivial · **Where:** `.github/workflows/ci.yml:19`

All three action uses are floating tags (actions/checkout@v4 twice, actions/setup-node@v4), which are mutable refs: a compromised or retagged action runs with the workflow's token on every push to every branch. No `permissions:` block is declared, so the job gets the repository default GITHUB_TOKEN scope rather than read-only. And `npm ci --no-audit --no-fund || npm install --no-audit --no-fund` means a lockfile that has drifted out of sync with package.json is silently resolved fresh from the registry instead of failing — the one place a lockfile is supposed to be authoritative. There is also no Dependabot/renovate config, so the 14 open moderate advisories have nothing watching them.

Evidence:

```
.github/workflows/ci.yml:14 `- uses: actions/checkout@v4`; :15 `- uses: actions/setup-node@v4`; :19 `run: npm ci --no-audit --no-fund || npm install --no-audit --no-fund`; :35 `- uses: actions/checkout@v4`
```

**Recommendation.** Pin each action to a full commit SHA with the version in a trailing comment (`actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v4.3.0`), add `permissions: contents: read` at workflow level, drop the `|| npm install`, and add .github/dependabot.yml with npm and github-actions ecosystems.

*Reviewer note (confirmed, severity lowered):* All four observations are factually correct, but the impact is small for this workflow. It has no `secrets` usage at all, does not push anything, and does not use GITHUB_TOKEN beyond checkout, so a compromised floating action tag would get a checkout token on a public personal repo rather than anything to steal or publish; fork PRs get a read-only token regardless of the missing permissions block. The `npm ci || npm install` masking a drifted lockfile is the item that actually costs something, and the missing Dependabot config is why SEC-7 went unnoticed. Worth fixing, low not medium. I could not verify "14 open moderate advisories" (no node_modules present and the registry is unreachable from this sandbox), so I neither confirm nor rely on that number.

### SEC-7 · decode-uri-component DoS is reachable at runtime through expo-router deep links

**Severity:** Low · **Category:** supply-chain · **Effort:** small · **Where:** `apps/mobile/package.json:28`

Of the 14 moderate advisories, thirteen are in the Expo build toolchain (@expo/cli, @expo/config-plugins, xcode -> uuid) and only run on the developer's machine. One reaches shipped code: decode-uri-component <=0.4.2 (exponential decoding of malformed percent-encoded input) is pulled in by query-string via expo-router, which parses incoming URLs at runtime. The app registers the `tvsham://` scheme in app.json, so any other app or a web page can hand it a crafted deep link and hang the JS thread. Impact is a local denial of service of the user's own app, not data loss, and npm's suggested 'fix' is a major downgrade of expo-router, so this is a track-and-wait item rather than an upgrade today.

Evidence:

```
apps/mobile/package.json:28 `"expo-router": "~57.0.19"`; npm audit: `decode-uri-component  moderate  <=0.4.2 ... via query-string <- expo-router`; apps/mobile/app.json:6 `"scheme": "tvsham"`
```

**Recommendation.** The suggested override of >=0.4.3 does not fix it - the fix landed in 0.5.0. Add `"overrides": { "decode-uri-component": "^0.5.0" }` to the root package.json, then confirm with `npx expo export` that query-string still bundles (0.5.0 changed packaging, so verify rather than assume). Add .github/dependabot.yml so the next expo-router that bumps query-string is noticed.

### BUG-2 · The look-ahead recording promise is created without a catch, so a rejection after the loop ends is unhandled

**Severity:** Low · **Category:** bug · **Effort:** trivial · **Where:** `apps/mobile/src/identify-run.ts:109`

The first recording is created as `producer.record().catch(() => null)`, but the look-ahead recording started while the previous clip uploads is not. When the server answers `wantsMore: false` the loop calls `producer.stop?.()` and breaks, and when the user cancels the function returns — in both cases that promise is left pending with no handler. If expo-camera's `recordAsync` rejects (interrupted recording, backgrounding, a camera error), React Native reports a 'Possible Unhandled Promise Rejection', and the video file it did produce is never referenced again so it lingers in the cache directory. The asymmetry with line 89 looks unintended.

Evidence:

```
apps/mobile/src/identify-run.ts:89 `let recording: Promise<string | null> = producer.record().catch(() => null);` versus :109 `recording = hasNext ? producer.record() : Promise.resolve(null);`; the loop then breaks at :117-120 and returns at :101/:115 without awaiting it.
```

**Recommendation.** Use `producer.record().catch(() => null)` in both places, and on the break/cancel paths `void recording.then((uri) => uri && deleteFile(uri))` so the abandoned recording is cleaned up rather than left in the cache.

### SEC-8 · Server responses are cast, never validated, although they arrive over cleartext HTTP

**Severity:** Low · **Category:** security · **Effort:** small · **Where:** `apps/mobile/src/api.ts:54`

`parse<T>` does `JSON.parse` and a bare TypeScript cast, so every field of RecognitionResult is trusted at face value and then rendered and persisted. Given BUG-3 (plain HTTP by default), an on-path attacker controls that JSON. `result.watch.length` (apps/mobile/app/result.tsx:255), `result.links.map` (:245) and `item.links.find` throw a TypeError and blank the screen if those fields are not arrays; a non-string `link.title` rendered as a React child crashes the result screen; and whatever is injected is written into the device library by `saveResult`, so the crash survives a restart until app data is cleared. The URL fields are the one part that is checked (isSafeWebUrl), which is what keeps this from being worse.

Evidence:

```
apps/mobile/src/api.ts:43-55 `async function parse<T>(res: Response): Promise<T> { ... return body as T; }`; apps/mobile/app/result.tsx:255 `{result.watch.length > 0 ? ...`; apps/mobile/app/library.tsx:13 `item.links.find((l) => ...)`
```

**Recommendation.** Add a small hand-written validator in the RN-free layer (the repo already has that pattern in settings.ts `sanitise`) that coerces the response: arrays default to [], strings to "", numbers clamped, unknown `kind`/`provider`/`status` values mapped to their fallbacks. Run it in `parse` and again when hydrating the persisted library, and add a unit test feeding it a hostile payload.

### BUG-4 · TMP_DIR is never swept, so a crash leaves uploaded clips on disk indefinitely

**Severity:** Low · **Category:** privacy · **Effort:** trivial · **Where:** `apps/server/src/index.ts:380`

`processClip` removes its work directory in a `finally`, which covers thrown errors — but not a process kill, an OOM, a container restart or a SIGTERM mid-analysis. `main()` creates config.tmpDir and never cleans what is already in it, so each abnormal exit leaves behind an up-to-80 MB clip plus its extracted frames and wav, forever, in a directory whose contents are recordings of the user's home. That contradicts the promise made in the README and in the app's own Settings copy ('Clips are deleted as soon as they have been analysed').

Evidence:

```
apps/server/src/index.ts:380 `await fs.mkdir(config.tmpDir, { recursive: true });` (create only); apps/server/src/index.ts:245-247 `} finally { await fs.rm(workDir, { recursive: true, force: true }); }`; README.md:30 "Every clip is deleted from the server as soon as it has been analysed."
```

**Recommendation.** At startup, after mkdir, remove everything already in tmpDir (`for (const e of await fs.readdir(tmpDir)) await fs.rm(path.join(tmpDir, e), { recursive: true, force: true })`), and add the same sweep to the existing 60-second sweepSessions interval for directories older than the session TTL. Also handle SIGTERM/SIGINT to stop accepting work and clean up.

### BUG-5 · Persisted library and history are restored with no shape check beyond Array.isArray

**Severity:** Low · **Category:** bug · **Effort:** small · **Where:** `apps/mobile/src/store.ts:99`

`hydrate` checks only that the parsed value is an array before installing it as the library/history, and the render path immediately dereferences nested fields (`item.links.find(...)`, `item.identification.title`). Settings get a proper `sanitise` for exactly this reason; SavedItem does not. Any future change to SavedItem's shape (or a partially written record) turns the Saved screen into a hard crash with no in-app recovery — the keys are already versioned (`tvsham.library.v1`) but nothing reads or bumps that version.

Evidence:

```
apps/mobile/src/store.ts:98-101 `const savedLibrary = l?.[1] ? (JSON.parse(l[1]) as SavedItem[]) : null; if (Array.isArray(savedLibrary)) libraryStore.set(savedLibrary);`; apps/mobile/app/library.tsx:12-13 `const primary = item.links[0]; const thumb = safeImageUri(item.links.find(...)?.imageUrl);`
```

**Recommendation.** As written, and apply the same validator in queue.ts's loadQueue (drop entries without a string uri and a source of "camera"|"screen") - it is the same class of bug in the path that runs unattended on every foreground event.

### BUG-6 · Session creation, polling and teardown have no request timeout

**Severity:** Low · **Category:** reliability · **Effort:** trivial · **Where:** `apps/mobile/src/api.ts:75`

`health()` uses `AbortSignal.timeout(6000)`, but `createSession`, `fetchSession`, `endSession` and the clip upload pass no timeout at all (upload only honours a caller-supplied signal, and useIdentify supplies none). Against a black-holed address — the common case when someone mistypes the LAN IP, or leaves the house while the Metro-host default is still configured — the fetch hangs until the platform's own TCP timeout, which on iOS is around 60 s and can be much longer. The user sees 'Identifying…' with no error and no queued clip, because the queue path is only reached once the request actually rejects.

Evidence:

```
apps/mobile/src/api.ts:57-61 `health(timeoutMs = 6000) { ... signal: AbortSignal.timeout(timeoutMs) }` versus :75-79 `createSession` and :129-133 `fetchSession` which pass no signal, and :102-107 where the upload uses `signal: opts.signal ?? null`
```

**Recommendation.** Give each call a bounded signal — `AbortSignal.any([opts.signal, AbortSignal.timeout(ms)].filter(Boolean))` with a short timeout for createSession/endSession/fetchSession and a generous one (2-3 minutes) for the upload — so a dead server surfaces as an error and the clip lands in the offline queue instead of hanging.

### MISS-3 · The keychain migration copies the bearer token out of AsyncStorage but never removes the plaintext copy

**Severity:** Low · **Category:** security · **Effort:** small · **Where:** `apps/mobile/src/store.ts:129`

readToken() migrates a token left in AsyncStorage by an older build into SecureStore and returns it, and hydrate() puts it in the in-memory store - but nothing rewrites the AsyncStorage record, so the plaintext token stays in the same unencrypted file the comment at store.ts:37-41 explains it is being moved out of, and stays in device backups. It is only scrubbed if and when the user next changes any setting, because updateSettings is the only writer that persists `{ ...rest, token: "" }`. A user who upgrades and never opens Settings again keeps the plaintext copy indefinitely, which is exactly the state the migration exists to end.

Evidence:

```
apps/mobile/src/store.ts:129-143 `async function readToken(legacy: string | undefined): Promise<string> { ... if (legacy) { await SecureStore.setItemAsync(TOKEN_KEY, legacy); return legacy; } ... }` (no AsyncStorage write); store.ts:93-97 `const savedSettings = ...; const token = await readToken(savedSettings?.token); if (savedSettings || token) { settingsStore.set(...) }` (hydrate never persists); store.ts:119-126 `updateSettings` is the only place that writes `{ ...rest, token: "" }`; store.ts:37-42 comment "the keychain rather than AsyncStorage, which is a plain file that device backups include"
```

**Recommendation.** In hydrate(), when readToken returned a legacy value, immediately rewrite the settings record with `token: ""` (the same shape updateSettings writes) so the migration is complete on first launch after the upgrade. One await in the hydrate try-block.

### MISS-4 · ffmpeg input is protocol-restricted but not demuxer-restricted, and the comment claims otherwise

**Severity:** Low · **Category:** security · **Effort:** small · **Where:** `apps/server/src/media.ts:47`

INPUT_GUARDS passes only `-protocol_whitelist file`, which correctly blocks http/tcp/rtp style SSRF. The comment above it says it restricts "only the demuxers we expect", which it does not do - ffmpeg still probes and selects a demuxer from content, so an upload saved as clip.mp4 can be an HLS/DASH playlist and the still-allowed `file` protocol lets its segment list name other local paths. Exploitability is genuinely limited (segments have to decode as media, and the interesting paths inside the container - the API key lives in the environment, not a file - are not video), and the frames go to Claude rather than back to the caller, so this is hardening rather than a live hole; but the recogniser's own write-up is returned to the caller in `identification.evidence`, so "whatever ends up in a frame can be described back to the uploader" is the shape of the worst case, and the guard the comment promises is the one that would close it.

Evidence:

```
apps/server/src/media.ts:47-52 `/** The input is chosen by whoever uploaded it: only local files, and only the demuxers we expect. ... */ const INPUT_GUARDS = ["-protocol_whitelist", "file"];`; media.ts:183-201 `await run([...INPUT_GUARDS, "-ss", ..., "-i", file, ...])` (no -f, no demuxer/decoder whitelist); apps/server/src/index.ts:204-207 the saved name is forced to a video extension but ffmpeg selects the demuxer by content, not extension; apps/server/src/recognize.ts:203 `evidence: analysis.slice(0, 400)` is returned to the caller
```

**Recommendation.** Add `-demuxer_whitelist mov,mp4,m4v,matroska,webm,avi,mpegts` and `-decoder_whitelist` for the codecs actually needed to INPUT_GUARDS (they apply to the next input), and fix the comment to say what the flags do. Keep -protocol_whitelist file. Add a media.test.ts case that feeds a text playlist referencing another local file and asserts assertDecodable rejects it.

### SEC-9 · /health stays unauthenticated when APP_TOKEN is set and discloses the server's configuration

**Severity:** Info · **Category:** security · **Effort:** trivial · **Where:** `apps/server/src/index.ts:73`

The bearer gate deliberately exempts /health so the container HEALTHCHECK works, but the response is not a bare liveness probe: it names the Claude model, the optional first-pass model, whether ffmpeg is present, the STT provider, whether TMDB is configured and the daily clip limit. For an internet-reachable instance that is free reconnaissance — it tells an attacker exactly how expensive each clip is and whether a cap is in place before they try anything. The fail-closed shape of the check itself is correct (an exact path match; anything else requires the token).

Evidence:

```
apps/server/src/index.ts:73 `if (!config.appToken || c.req.path === "/health") return next();`; apps/server/src/index.ts:93-104 builds the HealthResponse with `model`, `firstPassModel`, `stt`, `tmdb`, `dailyClipLimit`.
```

**Recommendation.** Return `{ ok: true }` (plus version) to unauthenticated callers and the full body only when the request carries the token — the Docker HEALTHCHECK only needs a 200. Alternatively bind a separate probe port to loopback.

## Upgrades

| Value | Effort | Upgrade | Now | Move to |
|---|---|---|---|---|
| high | small | Fix the cross-clip prompt-cache invalidator and add breakpoints on earlier frames | recognize.ts buildUserContent() opens with a text block '<N> frames sampled from <M> consecutive clip(s)' that changes on every clip, so although each clip re-sends every earlier frame (up to 24 JPEGs at 896 px, roughly 600 input tokens each) the byte-prefix after the system prompt never matches and cache_read_input_tokens is always 0; the only cache_control is on the system prompt | Move the count sentence after the frames (or drop it: the per-frame 'Frame at clip N, t=..' labels already carry it), add cache_control: { type: 'ephemeral' } to the last image block of each previous clip (system + 3 frame boundaries = the 4-breakpoint maximum, matching MAX_CLIPS_PER_SESSION=4), keep the per-request random fence and hint after the last breakpoint, and assert usage.cache_read_input_tokens > 0 on the second clip in recognize.flow.test.ts. Clips arrive 8-20 s apart, inside the 5-minute TTL; cache reads bill ~0.1x. Note the ~770-token system prompt is above Opus 5's 512-token cache minimum but below Sonnet 5's 1024, so FIRST_PASS_MODEL=claude-sonnet-5 silently gets no system-prompt caching today |
| high | small | Measure claude-opus-5 at lower effort before adopting the Sonnet cost cascade | output_config.effort is hard-coded to 'high' in recognise(); README and .env.example present FIRST_PASS_MODEL=claude-sonnet-5 as the cost lever, and recogniseWithEscalation re-sends identical evidence to a second model (caches are model-scoped, so zero reuse) | Add an EFFORT env (config.ts) and an --effort flag to eval/run.ts, run the existing harness for opus-5 at low/medium/high and compare with eval/compare.ts before enabling the cascade; Anthropic's current guidance is that lower effort on the newest model often matches prior-generation quality at high effort and keeps one cache namespace. Also consider running the second messages.parse extraction call on claude-sonnet-5 or claude-haiku-4-5 (it only converts the write-up to JSON) and measuring with the same harness |
| high | small | Make production builds able to reach a plain-HTTP LAN server (or require TLS) | README: 'the app talks plain HTTP to whatever URL you give it' and the settings placeholder is http://192.168.1.20:8787, but app.json has no expo-build-properties (Android release builds block cleartext traffic on API 28+) and no NSAppTransportSecurity / NSLocalNetworkUsageDescription (iOS ATS blocks http://; iOS 14+ prompts for local-network access) | Add expo-build-properties with android.usesCleartextTraffic: true (or a networkSecurityConfig limiting cleartext to RFC1918 ranges), ios.infoPlist NSAppTransportSecurity.NSAllowsLocalNetworking: true plus NSLocalNetworkUsageDescription; alternatively have settings.tsx refuse http:// for non-private hosts. Add an EAS preview-build smoke test of the health check |
| high | small | Stop shipping packages/shared as TypeScript source to the production server | packages/shared exports ./src/index.ts; apps/server dist/index.js imports runtime values (CONFIDENT_THRESHOLD, MAX_CLIPS_PER_SESSION...) from it, so `node apps/server/dist/index.js` in the Docker image only works because node:22-slim >= 22.18 strips types and the workspace symlink realpath sits outside node_modules. Root engines says >=20 and README says 'Node 20+', neither of which can import .ts. CI builds the image but never starts it | Build shared to dist with exports { import: ./dist/index.js, types: ./dist/index.d.ts } via tsc -b project references (server tsconfig references ../../packages/shared), or bundle the server with esbuild/tsdown into one file; add a CI step that starts the built image and curls /health (the HEALTHCHECK already exists) |
| high | trivial | Add a LICENSE | No LICENSE file; README invites people to host the server themselves and build the app | Add MIT or Apache-2.0 at the root and a license field in the three package.json files; note the TMDB attribution requirement already in README |
| medium | trivial | Add SECURITY.md, CHANGELOG.md and CONTRIBUTING.md | None present; README's 'Deploying safely' section and CLAUDE.md's 'Invariants worth not breaking' already contain the substance | SECURITY.md with a reporting address, supported versions and the APP_TOKEN/TLS/DAILY_CLIP_LIMIT deployment rules; CHANGELOG.md seeded from git log (the commit messages are already release-note quality); CONTRIBUTING.md pointing at the test/typecheck conventions in CLAUDE.md |
| medium | trivial | Pin GitHub Actions to commit SHAs, add permissions and concurrency | actions/checkout@v4 and actions/setup-node@v4 by mutable tag (0/3 pinned); no top-level permissions block; no concurrency group; no timeout-minutes | Pin to full SHAs (v5 majors exist for both; let Dependabot bump them), add `permissions: contents: read`, `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`, and timeout-minutes on both jobs |
| medium | trivial | Enable Dependabot for npm, github-actions and docker | No .github/dependabot.yml or Renovate config | Weekly Dependabot with npm updates grouped (one PR for expo*/react-native* ignored on majors, since those must move with `npx expo install --fix`; one for the server), plus github-actions and docker ecosystems |
| medium | small | Remove the `npm ci \|\| npm install` fallback and add audit / expo-doctor steps to CI | CI runs `npm ci --no-audit --no-fund \|\| npm install --no-audit --no-fund`; no npm audit, no expo-doctor, Metro export only for android, Docker image built but never run | Plain `npm ci` (a lockfile that fails ci should fail the build), `npm audit --audit-level=high` (moderate build-time noise from xcode/uuid should not block), `npx expo-doctor` in apps/mobile, `npx expo export --platform ios` as well, and a `docker run ... curl /health` smoke step |
| medium | small | Move to Node 24 LTS and pin it in one place | CI setup-node 22, Dockerfile node:22-slim, engines >=20, README 'Node 20+', CLAUDE.md 'Node 22'; no .nvmrc. Node 20 reached end-of-life 2026-04-30 and Node 22 leaves Active LTS in October 2026 | Add .nvmrc = 24, engines >=22.18 (the type-stripping floor) or >=24, `node-version-file: .nvmrc` in CI, node:24-slim in Dockerfile, @types/node ^24, and align README/CLAUDE.md. Node 24 also unflags node:sqlite, useful for persisting the daily cap |
| medium | small | Lint the server and shared packages, add a formatter check | eslint.config.js exists only in apps/mobile; root `npm run lint --workspaces --if-present` silently skips server and shared; no Prettier/Biome, no format check | Add a typescript-eslint flat config (recommended-type-checked) to apps/server and packages/shared, and Prettier or Biome with a `--check` CI step. The server lint would immediately flag index.ts:398 (`a && b \|\| c` without parentheses) and the unused probeDuration |
| medium | trivial | Fix the runtime-reachable decode-uri-component advisory with an npm override | expo-router 57 -> query-string 7.1.3 -> decode-uri-component 0.2.2 (GHSA-vcc3-ghjq-m6fr, exponential decoding DoS); expo-router parses deep-link query strings and the app registers scheme tvsham, so a crafted link can hang the JS thread. npm audit's 'fix' is a downgrade to expo-router 5 | Add root package.json `overrides: { "decode-uri-component": "<first patched release above 0.4.2>" }` (check `npm view decode-uri-component versions`), re-run npm audit, and remove the override when expo-router moves to query-string 9. The remaining moderate items (uuid via xcode via @expo/config-plugins, expo-splash-screen) are prebuild-time only |
| medium | small | Slim and harden the Docker image | Build stage installs ffmpeg it never uses, runs `npm ci --omit=dev --ignore-scripts` then `npm install --include=dev` (the second run downloads ffmpeg-static's ~70 MB binary and installs typescript/tsx), and `COPY --from=build /app /app` ships src, devDependencies and both ffmpeg binaries; base image unpinned; compose has no memory limit or read-only rootfs | build: `npm ci --ignore-scripts` -> `npm run build` -> `npm prune --omit=dev`; runtime stage copies only node_modules, packages/shared, apps/server/dist and package.json files; move ffmpeg-static to optionalDependencies (Docker uses apt ffmpeg); pin node:24-slim@sha256; compose `mem_limit`, `read_only: true` with a tmpfs at /tmp/tvsham |
| medium | small | Graceful shutdown and scratch-directory cleanup on boot | main() ignores the return of serve() and installs no SIGTERM handler, so `docker compose restart` kills up to MAX_CONCURRENT in-flight Claude calls mid-request and processClip's finally never runs; stale `<session>-<n>` work dirs from a crash are never removed (main only mkdirs) | Keep the server handle, on SIGTERM/SIGINT stop accepting, await the Limiter draining (add a `drain()` that resolves when running===0), then exit; on boot `fs.rm` everything under config.tmpDir |
| medium | small | Persist the daily cap and cap live sessions per caller | usage.ts is in-memory (resets on every deploy/restart, which the README acknowledges); MAX_SESSIONS=500 is global, so one address can create 500 sessions and lock everyone else out for up to sessionTtlMs (15 min) | Back UsageStore with node:sqlite (Node 22.5+/24) or a JSON file under TMP_DIR, and add a per-caller live-session ceiling (e.g. 5) using the existing caller(c) key in POST /sessions |
| medium | small | Respect reduced motion and announce status changes | SonarRings and Breathing loop unconditionally; the hero poster is blurred; nothing checks AccessibilityInfo.isReduceMotionEnabled; StatusPill text changes ('Listening… clip 2 of 4', 'Checking… could be X') are not announced; ConfidenceRing has no accessibilityLabel | A useReducedMotion hook (AccessibilityInfo.isReduceMotionEnabled + reduceMotionChanged) that swaps the loops for a static ring and shorter fades; accessibilityLiveRegion="polite" on the pill (Android) and AccessibilityInfo.announceForAccessibility on phase changes (iOS); accessibilityLabel={`${Math.round(value*100)} percent confidence`} on ConfidenceRing |
| medium | small | EAS/app-store readiness: dev client, project id, OTA updates, privacy policy | eas.json development profile sets developmentClient: true but expo-dev-client is not a dependency; app.json has no extra.eas.projectId/owner; no expo-updates or runtimeVersion (no OTA path, autoIncrement only bumps native builds); no privacy policy document although the app uploads camera video and microphone audio to a user-chosen server; config.version '0.1.0' is duplicated by hand in server config.ts | Add expo-dev-client (also needed for every native roadmap item), commit the EAS project id, add expo-updates with runtimeVersion { policy: 'fingerprint' }, write PRIVACY.md and link it from the Settings 'How it works' card, and read the server version from package.json |
| low | small | Turn on exactOptionalPropertyTypes and share a base tsconfig | mobile and server: strict + noUncheckedIndexedAccess; shared: strict only. The code already writes `...(x ? { y: x } : {})` everywhere as if exactOptionalPropertyTypes were on | Root tsconfig.base.json with strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride, noFallthroughCasesInSwitch; extend it from all three packages. Optionally try `typescript@7` (the native compiler, now `latest` on npm) for the CI typecheck step, keeping 5.9 if eslint-config-expo lags |
| low | small | Bring the lagging direct dependencies forward | @hono/node-server ^1.14 (1.19.17 installed; 2.1.1 current), eslint 9.39 (10.x current), @react-native-async-storage/async-storage 2.2.0 (3.1.1 current, but follow Expo's pin), expo 57.0.20 (57.0.21), react-native-screens/safe-area-context minor behind; @anthropic-ai/sdk 0.124.0, hono, zod 4, tsx, ffmpeg-static are current | `npx expo install --fix` for the Expo-managed set; bump @hono/node-server to 2.x (check getConnInfo import path) and eslint to 10 with eslint-config-expo; consider expo-sqlite/kv-store as an AsyncStorage drop-in with sync reads. Plan the SDK 58 move when it leaves canary |
| low | small | Use expo-image for remote artwork | React Native Image for posters, thumbnails, provider logos and cast photos (result.tsx, library.tsx, results.tsx) with no disk cache or placeholder; the hero is rendered twice (blurred backdrop + contain) | expo-image with cachePolicy="disk", contentFit, a placeholder colour from the palette and blurRadius on the backdrop; same URIs are re-downloaded every time the library re-renders today |
| low | small | Opt-in crash reporting and structured server logs | No crash/error reporting in the app; server logs are unstructured console.* plus Hono's logger, with no request id and nothing about tokens or latency per clip | sentry-expo / @sentry/react-native behind a default-off Settings toggle (no PII: clips never leave the device path); server: pino JSON logs with a request id, per-clip timing, model, stop_reason and usage fields (see the cost-telemetry feature) |
| low | medium | Externalise UI strings for i18n | Roughly 40 English strings inline across the five screens plus messages generated server-side in describe() ('Found it.', 'Might be X…'); expo-localization is installed but only used for the region code | A strings.ts (or i18n-js + expo-localization getLocales) for the app, and keep server messages as codes (`status` plus a `messageKey`) so the app renders them in the device language |

- **Fix the cross-clip prompt-cache invalidator and add breakpoints on earlier frames** (high value, small, `apps/server/src/recognize.ts`). Clips 2-4 of a camera session currently pay full price for frames the model has already seen; this is the largest single cost lever and it is a byte-ordering change
- **Measure claude-opus-5 at lower effort before adopting the Sonnet cost cascade** (high value, small, `apps/server/src/eval/run.ts`). The README admits the cost cascade is unmeasured; effort is the cheaper experiment and the harness already exists
- **Make production builds able to reach a plain-HTTP LAN server (or require TLS)** (high value, small, `apps/mobile/app.json`). The documented LAN flow only works in Expo Go / debug builds; the first APK from eas build --profile preview will fail with 'Cleartext HTTP traffic not permitted'
- **Stop shipping packages/shared as TypeScript source to the production server** (high value, small, `packages/shared/package.json`). Runtime correctness of the deployable artefact currently rests on an undocumented Node feature; a Node version pin or a future Node rule change breaks the image with no CI signal
- **Add a LICENSE** (high value, trivial, `LICENSE`). Without a licence nobody may legally fork, self-host or contribute, which is the product's entire distribution model
- **Add SECURITY.md, CHANGELOG.md and CONTRIBUTING.md** (medium value, trivial, `SECURITY.md`). The server spends the operator's API budget, so a disclosure path matters more here than for a typical side project
- **Pin GitHub Actions to commit SHAs, add permissions and concurrency** (medium value, trivial, `.github/workflows/ci.yml`). Standard supply-chain hygiene; the workflow runs on every push of every branch
- **Enable Dependabot for npm, github-actions and docker** (medium value, trivial, `.github/dependabot.yml`). Two direct deps are already a major behind (@hono/node-server 1.x vs 2.x, eslint 9 vs 10) and the moderate advisories will keep drifting unnoticed
- **Remove the `npm ci || npm install` fallback and add audit / expo-doctor steps to CI** (medium value, small, `.github/workflows/ci.yml`). The fallback hides lockfile drift, which is exactly what the pinned-versions note in CLAUDE.md is trying to prevent
- **Move to Node 24 LTS and pin it in one place** (medium value, small, `.nvmrc`). Four sources currently disagree, and one of them names an EOL release
- **Lint the server and shared packages, add a formatter check** (medium value, small, `apps/server/package.json`). Half the codebase (and the part that spends money) has no static analysis beyond tsc
- **Fix the runtime-reachable decode-uri-component advisory with an npm override** (medium value, trivial, `package.json`). It is the one advisory that is reachable at runtime through a user-controllable input
- **Slim and harden the Docker image** (medium value, small, `apps/server/Dockerfile`). Image size, build time and the defence-in-depth the README's decode-bomb section argues for
- **Graceful shutdown and scratch-directory cleanup on boot** (medium value, small, `apps/server/src/index.ts`). Every killed request is a paid API call with no answer, and orphaned clips contradict 'deleted as soon as analysed'
- **Persist the daily cap and cap live sessions per caller** (medium value, small, `apps/server/src/usage.ts`). Both are the operator's only defences once the server is public; the first resets on every deploy and the second is trivially exhausted
- **Respect reduced motion and announce status changes** (medium value, small, `apps/mobile/src/motion.tsx`). The commit history shows a11y is cared about (labels were added in f9066e3); motion and announcements are the remaining gaps
- **EAS/app-store readiness: dev client, project id, OTA updates, privacy policy** (medium value, small, `apps/mobile/eas.json`). `eas build --profile development` fails today, and store submission needs a privacy policy URL and data-collection declarations
- **Turn on exactOptionalPropertyTypes and share a base tsconfig** (low value, small, `apps/server/tsconfig.json`). The conventions are already followed by hand; the compiler should enforce them
- **Bring the lagging direct dependencies forward** (low value, small, `apps/server/package.json`). Two majors behind on the server adapter and linter; keeping in step is cheap now and expensive later
- **Use expo-image for remote artwork** (low value, small, `apps/mobile/src/results.tsx`). Cheaper scrolling in the library and faster result cards on repeat views
- **Opt-in crash reporting and structured server logs** (low value, small, `apps/server/src/index.ts`). A solo maintainer cannot reproduce device crashes without reports, and the operator cannot see what a clip cost
- **Externalise UI strings for i18n** (low value, medium, `apps/mobile/app/index.tsx`). Non-English users already get region-specific watch providers; the UI and Wikipedia edition should follow

## Features worth adding

- **Per-clip cost and token telemetry, surfaced in the eval report** (high value, small). recognise() discards response.usage from both API calls. Return { identification, usage } where usage sums input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens, server_tool_use.web_search_requests and records response.model (with fallbacks: 'default' the answering model can differ); accumulate on the Session, log it per clip in processClip, add `usage` and a `costUsd` computed from a small price table to ScoredClip in eval/score.ts, and print mean cost per clip and per correct answer in formatReport and compare.ts. This is the number the README says nobody has, and it is what decides FIRST_PASS_MODEL and the effort setting.
- **Share-sheet target for screen recordings and links** (high value, medium). The README's first blocked item. Add expo-share-intent (config plugin) and expo-dev-client; in app/_layout.tsx use useShareIntent() and route to '/' with a `shared` param; in app/index.tsx ScreenMode, when the param carries a video URI call start('screen', { record: async () => uri }, { maxClips: 1, hints }) automatically, and when it carries text containing a URL hand it to the link-resolve feature below. Removes the 'stop recording, open TVsham, tap Choose, find the file' dance that is the whole friction of screen mode.
- **Resolve a pasted or shared link without a clip (no API cost)** (medium value, small). Add POST /resolve { url } in apps/server/src/index.ts that reuses youtubeLinkFromUrl, platformVideoLink and enrich() from resolve.ts/tmdb.ts (plus wikipediaLink for wikipedia URLs) and returns a RecognitionResult with status 'identified' and no Claude call; in the app add a third mode tab 'Link' next to 'Point at a TV' / 'My screen' with a TextInput that accepts the clipboard, and handle tvsham://resolve?url= for the share sheet. Gives the library and where-to-watch features a zero-cost entry point.
- **Make 'Not this? It might be' alternatives resolve properly** (medium value, small). result.tsx currently opens an en.wikipedia.org search in the browser for each alternative. Add POST /sessions/:id/choose { index } that takes identification.alternatives[index] (title, kind, year), builds an Identification with the session's original evidence text, runs resolveLinks and enrich, stores it as s.last and returns describe(s); the app swaps the card in place via setLastResult and records history. Hooks: index.ts route next to the clips route, result.tsx alternatives Pressable onPress.
- **Show what the server is doing while the user waits** (medium value, small). Recognition takes 10-30 s and the app shows a fixed 'Identifying…'. Add a `stage: 'decoding' | 'transcribing' | 'identifying' | 'verifying'` field to Session (sessions.ts) set at each step of processClip, expose it in describe() and the RecognitionResult type in packages/shared, and have identify-run.ts/useIdentify.ts poll fetchSession every 2 s while phase === 'uploading' (fetchSession and the 202 polling already exist in api.ts) so StatusPill can render 'Searching the web…'. Cancel the poll when the upload resolves.
- **Pinch-to-zoom and a 1x/2x toggle in camera mode** (medium value, small). On-screen text is the strongest signal per the system prompt, and a 480p clip of a TV across the room loses it. Wire CameraView's `zoom` prop in app/index.tsx CameraMode to a pinch gesture (react-native-gesture-handler is already installed transitively via expo-router; add it as a direct dependency) and a small 1x/2x button beside the capture button; remember the last zoom in Settings.
- **Library search, filters and JSON/CSV export** (medium value, medium). The saved list is a flat SectionList. Add a search field and watched/unwatched + kind chips to app/library.tsx, and an 'Export' action that writes the library as JSON (round-trippable via expo-document-picker import) and as a Letterboxd/Trakt-compatible CSV (title, year, tmdb id) shared through expo-sharing. Requires carrying `tmdbId` from tmdb.findId() into RecognitionResult/SavedItem in packages/shared so exports and future 'refresh where to watch' have a stable key. This is the README's 'sync and export' item without the OAuth part.
- **Home-screen quick action that starts identifying immediately** (medium value, small). The README rates capture speed as the highest-value item and rules out lock-screen controls for needing native code; expo-quick-actions is the no-native-code slice. Register an 'Identify now' action in app/_layout.tsx, route to '/?autostart=camera', and in CameraMode call start() once onCameraReady fires when that param is present. Needs a dev build (not Expo Go), which the share-sheet feature requires anyway.
- **Pick the Wikipedia edition from the device language** (medium value, small). api.ts already sends getLocales()[0].regionCode as `region`; also send languageCode as `lang`, validate it in index.ts (cleanLang: /^[a-z]{2,3}$/), store it on the Session, and pass it to wikipediaLink(title, lang) in resolveLinks with a fallback to config.wikipediaLang when the edition has no article. Also fix result.tsx, which hard-codes en.wikipedia.org for alternative searches, to use a server-provided search link.
- **Share a result** (medium value, trivial). Add a 'Share' button to app/result.tsx (React Native Share.share({ message: `${title} — ${subtitle}`, url: primary.url })) and a share action on library rows; the primary ResolvedLink and subtitleFor() already produce the text. Shazam's most-used post-result action and a trivial addition.

## Code quality

- **Recorded clips are never deleted from the app cache, contradicting the permission copy** (high value, small, `apps/mobile/src/identify-run.ts`). The camera permission card says 'Nothing is stored after it's identified' (app/index.tsx:238), but every recordAsync output and every ImagePicker copy stays in the cache directory: an uploaded clip is only forgotten (unsentClipUri = null, line 113) and the pre-recorded next clip that is abandoned when wantsMore is false (line 109/118) is never touched. Add a `discard(uri)` dependency to IdentifyDeps (implemented with expo-file-system File.delete in useIdentify.ts), call it after a successful upload and for the abandoned recording, and add two identify-run tests asserting which URIs were discarded.
- **Missing tests for the money path in the app** (high value, medium, `apps/mobile/src/api.ts`). api.ts (retry-once on network error but not ApiError, 202 -> pollUntilSettled until analysing=false, give-up after 20 polls, abort mid-poll, errorText precedence), queue.ts (move-then-persist, MAX_QUEUED eviction deletes the file, flush removes 400/413 but keeps 429/5xx, only one flush in flight) and store.ts (token migration AsyncStorage -> SecureStore, sanitise on hydrate) have no tests because they import RN modules. Following the repo's own convention, extract pure cores with injected fetch/file/storage ports (api-core.ts, queue-core.ts) and test them with node:test like identify-run.ts.
- **Duplicated clip pipeline between the server and the eval harness** (medium value, small, `apps/server/src/eval/run.ts`). analyse() (lines 55-78) re-implements processClip (index.ts:201-224): same `looked`/`frameCount` arithmetic, but it calls probeDuration instead of assertDecodable (eval clips bypass the decode guards) and omits spanSeconds (extractFrames re-probes). Extract `analyseClipFile(clipPath, workDir)` returning { frames, transcript, looked } into a new pipeline.ts used by both; probeDuration then has no callers and can go. The unexplained constants in that arithmetic (12 max frames, one frame per 4 s, 896 px long edge, -q:v 4, MAX_EVIDENCE_FRAMES 24) belong in config.ts with a comment each.
- **stt.ts bypasses http.ts and has no timeout** (medium value, small, `apps/server/src/stt.ts`). whisperHttp uses the global fetch directly, contrary to the CLAUDE.md rule that server network goes through http.ts so tests can stub it, and unlike getJson it passes no AbortSignal: a hung transcription endpoint holds a Limiter slot and the session's busy chain indefinitely (ffmpeg has a timeout; STT does not). Add postForm()/fetchWithTimeout to http.ts, route whisperHttp through it, and add stt.test.ts (non-2xx -> null with a warning, timeout -> null, { text } trimmed, empty -> null, Authorization only when STT_API_KEY is set).
- **Contrast failures the palette test cannot see** (medium value, small, `apps/mobile/app/library.tsx`). library.tsx:33 renders the Watched chip with textColor '#111' on c.success, which in the light scheme (#07784a) is about 3.4:1; format.ts providerBadge hard-codes '#fff' on the YouTube (#ff3d3d, about 3.5:1) and Instagram (#e1306c, about 4.3:1) brand colours, both below AA for 12 px chip text. Add successText/brandText tokens to palette.ts and extend TEXT_PAIRS (and a providerBadge loop) in palette.test.ts so chips are audited like body text.
- **recognise() ignores max_tokens truncation and the fallback model** (medium value, small, `apps/server/src/recognize.ts`). Only refusal and pause_turn are handled: a stop_reason of max_tokens hands a truncated analysis to the extraction call as if complete, the 4-iteration pause_turn cap silently uses whatever partial text exists, and response.model is never logged although fallbacks: 'default' may have answered on another model. Handle max_tokens (retry once with a larger budget or return a low-confidence unknown), log stop_reason and model per call, and add flow tests for both paths using the existing fakeClient.
- **getJson hides misconfiguration as 'no results'** (medium value, small, `apps/server/src/http.ts`). Every failure becomes null with no logging, so a wrong TMDB_API_KEY (401) or YOUTUBE_API_KEY is indistinguishable from an empty search, while /health reports tmdb: true merely because a key is set. Log non-2xx with the host only (the TMDB key is a query parameter, so never log the URL), and validate keys at startup or in /health with a cheap call. Better still, send the TMDB key as a v4 Bearer token so it is not in URLs at all.
- **index.ts is four modules in one file** (medium value, medium, `apps/server/src/index.ts`). 404 lines mix the Hono app, processClip, describe() (status thresholds that the app mirrors), caller/quota helpers and the process bootstrap; tests import `app` from the same module that starts listening. Split into routes.ts, pipeline.ts (processClip), describe.ts and a thin index.ts; add parentheses at line 398 (`a && b || c`). describe() then gets direct unit tests for identified/listening/unsure/failed x canContinue, which today are only reached through the ffmpeg pipeline test.
- **Capture screen is a 423-line file with drifted thresholds** (medium value, small, `apps/mobile/app/index.tsx`). CameraMode, ScreenMode, HintField and StatusPill plus 80 lines of styles live in the route file; move them to src/capture/. StatusPill uses `guess.confidence > 0.3` while packages/shared defines MIN_USEFUL_CONFIDENCE = 0.35, and ConfidenceRing (motion.tsx:110) re-types 0.7/0.35 instead of importing CONFIDENT_THRESHOLD/MIN_USEFUL_CONFIDENCE. result.tsx:26 also evaluates the same 'is saved' predicate twice (library.some(...) || isSaved(result)).
- **Missing server tests for sessions, config, quota route and trustProxy** (medium value, small, `apps/server/src/sessions.ts`). No tests for sweepSessions TTL / touchedAt refresh, config.ts env parsing (positiveInt fallbacks, TRUST_PROXY, empty-string handling), caller() with trustProxy=true taking the first X-Forwarded-For hop, or the 429 path through POST /sessions/:id/clips with DAILY_CLIP_LIMIT=1 (only the header short-circuit and header-independence are covered). Each is a 10-line node:test.
- **config.ts parses inconsistently and duplicates the version** (low value, small, `apps/server/src/config.ts`). port is `Number(env(...))` with no validation (NaN reaches serve()), dailyClipLimit uses an inline Math.max/Math.floor instead of the nonNegativeInt helper two lines above, stt.provider is cast with `as` so a typo like STT_PROVIDER=whisper silently disables transcription, and version '0.1.0' is copied from package.json by hand. Parse the environment once with a zod schema (already a dependency), fail fast with a readable message, and read the version from package.json.
- **Dead per-install device id and unused expo-crypto** (low value, trivial, `apps/mobile/src/store.ts`). getDeviceId/DEVICE_KEY/newDeviceId and the X-Device-Id header in api.ts exist only to send an identifier the server deliberately ignores (index.ts:37-57 bills by socket address). Remove the header, the store code, the expo-crypto dependency and the README sentence about it: an identifier that is stored and transmitted but never used is a privacy cost with no benefit.
- **Palette tokens bypassed on the camera screen; unused danger variant** (low value, trivial, `apps/mobile/app/index.tsx`). Lines 384-416 hard-code '#000', 'rgba(255,255,255,0.25)', 'rgba(255,255,255,0.8)' and 'rgba(0,0,0,0.6)' although palette.ts defines onCamera/onCameraDim for exactly this (onCameraDim has zero uses). ui.tsx's 'danger' Button variant hard-codes '#ffffff' and is never used; either delete it or use it for the queue's Discard button.
- **resolveLinks runs its lookups serially** (low value, small, `apps/server/src/resolve.ts`). Up to five Wikipedia candidates are tried one after another (each getJson has an 8 s timeout), then youtubeLinkFromUrl, then trailerLink; a slow Wikipedia can add 30 s+ to a clip while the Limiter slot is held. Fire the first two candidates and the YouTube/trailer lookups with Promise.all and keep the ordering when assembling, matching how index.ts already parallelises resolveLinks and enrich.
- **Stale comment: hints are used** (low value, trivial, `apps/server/src/recognize.ts`). Evidence.hints is documented as '(unused today, reserved)' at line 24, but buildUserContent sends it inside the random fence (lines 115-120) and pipeline.test.ts exercises it. CLAUDE.md warns that scripted edits have dropped changes before; this comment is that failure mode.
- **Three different 'run when invoked directly' idioms and an unvalidated labels.json** (low value, small, `apps/server/src/eval/run.ts`). index.ts, compare.ts and run.ts each guard main() differently (run.ts always runs it, so parseArgs/readLabels cannot be imported by a test). Standardise on one isMain(import.meta.url) helper, validate labels.json with a zod schema (a misspelled `kind` today silently scores as 'wrong'), and test parseArgs defaults and --limit.
- **queue.ts re-implements the store's pub-sub** (low value, trivial, `apps/mobile/src/queue.ts`). queue.ts keeps its own `listeners` Set + emit() + useSyncExternalStore wrapper (lines 30-79) that duplicates createStore() in store.ts. Move createStore to src/store-core.ts and build the queue on it, which also removes the queue -> store -> api import tangle (queue.ts imports setLastResult from store.ts and store.ts is imported by api.ts).

## Shared across all Platteration repositories

The same gaps recur in every repository; fixing them once as a template and copying it is cheaper than fixing them fourteen times.

### CI and supply chain

1. **No workflow sets `permissions:`** (except the two Pages deploy jobs). Add `permissions: { contents: read }` at the top of every workflow so the `GITHUB_TOKEN` handed to third-party actions cannot write to the repository.
2. **No action is pinned to a commit SHA** (0 of 50 `uses:` lines across the fourteen repositories). `actions/checkout@v4` follows a movable tag; pin to the full 40-character SHA with the version in a comment, and let Dependabot bump it.
3. **No repository has Dependabot or Renovate.** Add `.github/dependabot.yml` with `npm` (or `pip`) and `github-actions` ecosystems, weekly.
4. **No CI step runs `npm audit`** (two workflows pass `--no-audit` explicitly). Add `npm audit --audit-level=high` after `npm ci`; for the Expo apps the current transitive advisories are build-time only (`uuid` via `xcode` via `@expo/config-plugins`), so gate on `high` rather than `moderate` until Expo ships the fix.
5. **`tvsham` runs `npm ci || npm install` in CI and in its Dockerfile.** The fallback silently discards the lockfile guarantee; drop it and fix the lockfile instead.
6. **`selfreportle`, `simplacad` and `phonogeometry` have no lockfile** and install Playwright ad hoc in CI. Add a `package-lock.json` (even with devDependencies only) and use `npm ci`.
7. **Enable secret scanning and push protection** in each repository's settings; nothing is committed today, and this keeps it that way.

### Repository hygiene

8. **Ten repositories have no `LICENSE`** (battleshiple, collectcollect, drawdraw, multidcheckers, multidconnect4, notenote, randostats, selfreportle, simplacad, tvsham). Without one, nobody else may legally use or contribute to the code. The siblings that have one use MIT.
9. **Only `simplacad` has a `SECURITY.md`.** Copy it to the others with a private reporting address.
10. **No repository has a `main` branch.** In all fourteen the default branch is the original `claude/...` feature branch, so branch protection, Dependabot targets and the two GitHub Pages workflows (`abientnoiser`, `chesscheatser` both trigger on `main`/`master`) all point at a branch that does not exist; those deploys have never run. Create `main` from the current branch, make it the default, and protect it.
11. **`drawdraw` is the one repository still on Expo SDK 53** (the rest are on 57). Its eight high-severity `npm audit` findings (`image-size`, `metro`) disappear with the SDK upgrade; it is also the only app not written in TypeScript and the only one pinned to Node 20 in CI.
12. **`multidcheckers` and `multidconnect4` are near-identical copies** (same branch name, same 65-file layout, same dependencies). The timeline/multiverse engine, persistence and share code should live in one shared package so fixes land in both.

### A hardened workflow to copy

```yaml
name: CI
on:
  push:
    branches: ["**"]
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@<full-sha> # v4
      - uses: actions/setup-node@<full-sha> # v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npm audit --audit-level=high
      - run: npm run lint --if-present
      - run: npm run typecheck --if-present
      - run: npm test
```
