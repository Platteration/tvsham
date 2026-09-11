# TVsham – notes for Claude Code

"Shazam for video": an Expo app records a few seconds of a TV (camera) or takes a screen
recording, a Node server extracts frames + audio with ffmpeg, Claude identifies the
content with web search, and the server returns verified Wikipedia / YouTube links.

## Layout

- `apps/mobile` – Expo SDK 57, expo-router. Screens in `app/`, logic in `src/`
  (`identify-run.ts` is the record → upload → repeat loop, with its IO injected so it
  can be tested without a renderer; `useIdentify.ts` is the React wrapper around it; `store.ts` holds settings and the
  saved library; `api.ts` talks to the server; `theme.tsx` owns the light/dark palettes).
  Path alias `@/` → `src/`.
- `apps/server` – Node 22 ESM, Hono. `index.ts` routes, `media.ts` ffmpeg, `recognize.ts`
  Claude, `resolve.ts` Wikipedia/YouTube/TikTok, `tmdb.ts` optional where-to-watch and
  cast, `stt.ts` optional speech-to-text, `sessions.ts` in-memory session store,
  `limiter.ts` concurrency, `usage.ts` the daily cap, `eval/` an offline accuracy
  harness (`npm run eval --workspace apps/server`).
- `packages/shared` – types and tuning constants used by both sides.

## Commands

```bash
npm install
npm run lint                       # eslint on the app
npm run typecheck                  # every workspace
npm test                           # node:test in both workspaces; no network or API key
npm run server                     # tsx watch, port 8787
npm run mobile                     # expo start
cd apps/mobile && node scripts/make-icons.mjs   # regenerate assets/*.png
```

## Conventions

- Keep server responses in the shapes from `packages/shared`; the app only renders them.
- Network access in the server goes through `http.ts` `getJson` so tests can stub it.
- Claude is called via `@anthropic-ai/sdk` only (`recognize.ts`). Two calls per clip:
  vision + web search reasoning, then a `messages.parse` structured extraction.
- Uploaded clips live under `apps/server/tmp/<session>-<n>` and are deleted after analysis.
- No test can hit the real API. Verify changes with typecheck, the unit tests, and
  `npx expo export` for the app bundle.
- App logic worth testing goes in a React-Native-free module (`palette.ts`,
  `settings.ts`, `format.ts`, `queue-policy.ts`, `identify-run.ts`, `shapes.ts`,
  `deadline.ts`); the `.tsx` files
  then hold only rendering. That is what makes `npm test` possible in `apps/mobile` at all.
- Colour changes must keep `palette.test.ts` green: it checks every text pairing in
  both schemes and all four accents against WCAG AA.

## Invariants worth not breaking

These each came from a reproduced bug or a security finding; a change that undoes one
will pass typecheck and tests but reopen the hole.

- **Bill callers by something they cannot choose.** `caller()` in `index.ts` uses the
  socket address, not a header. Counting `X-Device-Id` or an untrusted
  `X-Forwarded-For` lets anyone reset the daily cap by editing a header. When a proxy
  is declared (`TRUST_PROXY` is a *count* of them), the hop is taken `hops` from the
  **right**: every proxy appends the address it saw, so the leftmost entry is the one
  the client typed. `addressBucket` answers `ip:unknown` for anything `net.isIP`
  rejects, so a garbage hop cannot mint a bucket of its own either — but a hop is
  normalised first (`bareAddress` strips a `:port` and the brackets round `[v6]:port`,
  which Azure's App Service and Application Gateway write), because failing those closed
  puts *every* client into the one shared bucket and makes each cap global. Anything
  still unreadable warns once: fail-closed and silent is indistinguishable from the cap
  being hit.
- **A session is authorised by its key, never by the network.** `POST /sessions` mints
  a 256-bit key beside the id and returns it once; `GET`, `DELETE` and clip upload
  compare `X-Session-Key` with `timingSafeEqual` (404, never 403, on a miss), and the
  request logger redacts `/sessions/<id>` because the id is in the path of every
  request and so in every access log on the way. Do **not** bind these routes to
  `caller()` instead: the client is a phone in a record → upload → repeat loop, and
  walking out of the house, a carrier NAT rotating or a VPN reconnecting would answer
  its own next clip with a 404. `caller()` is for billing and rate limiting, which is
  what the invariant above is about; this is a different question.
- **Re-check per-session limits inside the `s.busy` chain**, not at request entry:
  `s.clips` only moves inside `processClip`, so an entry check lets concurrent uploads
  all through.
- **Frame extraction is one ffmpeg run, not one per frame.** Spawning per frame re-opens
  and re-probes the file each time: measured ~5x slower on a typical 8-second clip.
- **Bound the probe, not only what it reports.** The input is attacker-supplied; a
  424 KB file can declare 16000x9000 and cost gigabytes to decode one frame. The budget
  is for the *file*, not for one stream: ffmpeg opens a decoder for every stream while
  probing, so `assertDecodable` adds the streams' pixels up as well as measuring the
  largest. But those numbers are read *out of* `probe()`, so they can only ever refuse a
  file after that run has allocated — eight streams of 8192x4608 are a 1.4 MB upload
  that cost 749 MB to refuse, and `MAX_UPLOADS_PER_CALLER` gives one address three at
  once, past the 2 GB the compose file allows. What bounds the probe itself is
  `-max_streams` (`MAX_STREAMS`, which counts every stream, not only video) and
  `probeBudget()`'s `-probesize`/`-analyzeduration 0`, which stops ffmpeg decoding
  frames to work out what the container did not declare: 736 MB becomes 113 MB, and a
  real clip costs what it always did, because dimensions, stream count and duration are
  all in the header. `PROBE_MEMORY_MB` is a second line under that, and a probe that
  will not fit is refused rather than waved through. Under the probe budget ffmpeg
  *names a stream twice* — once in the listing, once in a "Could not find codec
  parameters" line — so the parser keys streams by `#file:index`; counting banner lines
  double-counts them and refuses real clips. `media.test.ts` measures the peak RSS of
  `assertDecodable` on a hostile file against the cost of probing one stream of the same
  size, because a test that only asserts the refusal passed happily while the refusal
  cost three quarters of a gigabyte.
- **The server waits for a body longer than the app will spend sending one.**
  `REQUEST_TIMEOUT_MS` is derived from `UPLOAD_DEADLINE_MS` in `packages/shared`, which
  is also the app's own deadline. Set independently they disagreed (120 s against
  180 s), and a body cut off mid-upload is not an HTTP status: the app reads it as a
  transport failure, queues the clip and retries it into the same wall for ever. 80 MB
  is a whole screen recording, and 80 MB in 120 s is a sustained 5.3 Mbit/s uplink.
- **Cap the frames carried in `s.evidence`.** Each clip re-sends the whole session, so
  without a ceiling the image tokens grow with the square of the clip count.
- **Untrusted text (transcripts, hints, model write-ups) is fenced with a per-request
  random delimiter.** A fixed fence can be closed by the content itself.
- **The app checks a URL is http(s) before opening or rendering it** (`isSafeWebUrl`).
  The server is reached over plain HTTP by default, and Android will launch another app
  from an `intent://` URL.
- **CORS stays off unless `CORS_ORIGIN` is set.** The app is not a browser; permissive
  headers would let any web page spend the operator's Claude budget. Not sending them
  is only half of it: a browser still *delivers* a request that needs no preflight, so
  a cross-origin `Origin` is refused outright and `POST /sessions` takes nothing but
  `application/json` — the encodings an HTML form can produce are the ones that arrive
  without an `Origin`. `CORS_ORIGIN=*` is refused at startup rather than honoured: the
  gate compares the Origin with that string, so a wildcard is a preflight answered 204
  and the request behind it answered 403, and the alternative — treating it as "any
  origin" — is the hole the gate exists to close.
- **The listener binds loopback unless `HOST` says otherwise.** SEC-1 was fixed by
  binding the *published Docker port*; the listener itself still took every interface,
  so `npm run server` on a laptop put an unauthenticated server on every network the
  laptop joined, under a banner that said localhost. The image sets `HOST=0.0.0.0`,
  because in a container the published port is the boundary.
- **Admit an upload before its body is read.** `parseBody` materialises the whole
  multipart body in the request's own turn, before the `s.busy` chain and before
  `limiter.run`, so `MAX_UPLOADS_IN_FLIGHT` is counted at request entry and released
  in a `finally`. The limiter bounds how many clips are *analysed*, which does not
  bound how much is resident. "Request entry" means `admitClip`, registered **ahead of
  the `bodyLimit` middleware**: with no `Content-Length` to read, that middleware
  drains the whole body into memory to measure it, so a check after it has already paid
  for the upload whatever it answers. One caller gets `MAX_UPLOADS_PER_CALLER` of those
  slots, because a body is only released when all of it has arrived and nothing obliges
  a client to send it.
- **ffmpeg chooses the demuxer from the content, not from the name.** `inputGuards()`
  carries `-format_whitelist` as well as `-protocol_whitelist`: an upload saved as
  clip.mp4 that begins `ffconcat version 1.0` is opened by the concat demuxer, which
  then names other local files for the still-permitted `file` protocol to read.
- **A whitelist is an own-property lookup, never `key in TABLE` or a bare
  `TABLE[key]`.** Every name on `Object.prototype` — `constructor`, `__proto__`,
  `toString` — is truthy on a plain object table, so `in` accepted `toString` as an
  accent name, `sanitise()` kept it, and `ACCENTS[accent]` then handed the whole app
  `undefined` for its accent colour: the WCAG pairings `palette.test.ts` pins, silently
  not pinning anything. `isAccentName` uses `Object.prototype.hasOwnProperty.call`, and
  the tests walk `Object.getOwnPropertyNames(Object.prototype)` rather than listing
  names someone has to remember. The other tables keyed by outside values are already
  safe by construction (`oneOf` over an array in `shapes.ts`, literal comparisons in
  `resolve.ts`); keep new ones that way.
- **What comes back from the server, or off the disk, is coerced rather than cast**
  (`shapes.ts`). The session handle is part of that: the id goes in a URL path and the
  key in an `X-Session-Key` header, so both are charset-checked the way the server
  checks a clip key — a value with a newline in it makes `fetch` throw, and a thrown
  fetch is what the app reads as "the network is down". The hop is cleartext by default and the payload is then persisted,
  so a `links` that is not an array is a blank screen that survives a restart.
- **A response has a ceiling; the app's own stored lists do not.** `MAX_ITEMS` keeps one
  reply from filling the device, so it applies to what arrived over the wire —
  `storedItems` reads a stored list whole. The saved library is capped nowhere else, so
  a ceiling on the read drops the oldest saved items and the next `persistLibrary`
  writes the shorter list over the record for good. A list that should be bounded is
  bounded where it is written, as history is by `HISTORY_LIMIT`.

## Things that trip people up

- Never import a colour constant directly: use `useTheme()` for inline colours and
  `makeStyles((c) => ...)` for stylesheets, or the screen will be stuck in one scheme.

- iOS ignores `videoQuality` on `recordAsync` unless a `codec` is passed.
- expo-router 57 vendors react-navigation; import `ThemeProvider`/`DarkTheme` from
  `expo-router`, not `@react-navigation/native`.
- `expo install` needs network to Expo's API; pin versions from
  `node_modules/expo/bundledNativeModules.json` when offline.
- Editing files with scripted string replacement fails silently when the anchor text has
  drifted. Grep for the new text afterwards; two edits to this file were lost that way.
