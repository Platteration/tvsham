# TVsham – notes for Claude Code

Read AGENTS.md first. It holds the working rules every coding agent follows in this repository; this file adds the notes specific to this project.

"Shazam for video": an Expo app records a few seconds of a TV (camera) or takes a screen
recording, a Node server extracts frames + audio with ffmpeg, Claude identifies the
content with web search, and the server returns verified Wikipedia / YouTube links.

## Layout

- `apps/mobile` – Expo SDK 57, expo-router. Screens in `app/`, logic in `src/`
  (`identify-run.ts` is the record → upload → repeat loop, with its IO injected so it
  can be tested without a renderer; `useIdentify.ts` is the React wrapper around it; `store.ts` holds settings and the
  saved library; `api.ts` talks to the server; `theme.tsx` owns the light/dark palettes).
  Path alias `@/` → `src/`. It is also the website: `public/` (the page template, safety
  net, 404 page and host configs the export copies into the site), `deploy/nginx.conf`,
  `scripts/build-web.mjs`, and `e2e/` (the browser suite). See Website below. The website's
  account and accent shop: `account-model.ts` (what api/ says, read field by field, and the
  words), `account-client.web.ts` (the one module that asks the site's api/; Metro bundles it
  into the web build alone) and its inert native twin `account-client.ts`, `account.ts` (the
  state the screens draw from) and `account-ui.tsx` (the cards and the notice).
- `apps/server` – Node 22 ESM, Hono. `index.ts` routes, `form.ts` what a clip upload's
  body may be before it is parsed, `media.ts` ffmpeg, `recognize.ts` Claude, `resolve.ts`
  Wikipedia/YouTube/TikTok, `tmdb.ts` optional where-to-watch and
  cast, `stt.ts` optional speech-to-text, `sessions.ts` in-memory session store,
  `limiter.ts` concurrency, `usage.ts` the daily cap, `eval/` an offline accuracy
  harness (`npm run eval --workspace apps/server`). `account.ts` mounts the shared kit for
  the website's account and shop, `catalogue.ts` is what it sells, and `src/testing/` holds
  the fake Google and Stripe the tests hand it (left out of the build by tsconfig.json).
  `apps/server/kit/` is the shared kit (sign in with Google, Stripe Checkout and its
  webhook), byte for byte the canonical copy: the charter's `server/kit/`, kept inside the
  server's workspace because that is what the image copies and what the server's lint,
  type check and tests walk. Never edit it here; a change goes to the canonical copy.
- `packages/shared` – types and tuning constants used by both sides.

## Commands

```bash
npm install
npm run lint                       # eslint in every workspace
npm run typecheck                  # every workspace
npm test                           # node:test in both workspaces (the server's runs kit/selftest.mjs first); no network or API key
npm run test:conventions           # the shared repository conventions (CONVENTIONS.md)
npm run check                      # lint, typecheck, test, test:conventions: the gate before a push
npm run test:e2e                   # the website in Chromium: builds, serves and drives it
TVSHAM_SERVER_URL=https://… npm run build:web --workspace apps/mobile   # the website, in apps/mobile/dist
npm run server                     # tsx watch, port 8787
npm run mobile                     # expo start
cd apps/mobile && node scripts/make-icons.mjs   # regenerate assets/*.png
```

## Project conventions

- Keep server responses in the shapes from `packages/shared`; the app only renders them.
- Network access in the server goes through `http.ts` (`getJson`, `postForm`, and `outbound`,
  the kit's way to Google and Stripe) so tests can stub it.
- Claude is called via `@anthropic-ai/sdk` only (`recognize.ts`). Two calls per clip:
  vision + web search reasoning, then a `messages.parse` structured extraction.
- Uploaded clips live under `apps/server/tmp/<session>-<n>` and are deleted after analysis.
- No test can hit the real API. Verify changes with typecheck, the unit tests,
  `npx expo export` for the app bundle, and `npm run test:e2e` for the website (which
  stands in for Claude and the outside world through `setClientForTests`/`setFetchForTests`).
- App logic worth testing goes in a React-Native-free module (`palette.ts`,
  `settings.ts`, `format.ts`, `queue-policy.ts`, `identify-run.ts`, `shapes.ts`,
  `deadline.ts`, `clip-upload.ts`, `account-model.ts`, `account.ts`); the `.tsx` files
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
- **A clip leaves a phone through React Native's XMLHttpRequest, not `fetch`.** SDK 57
  makes `expo/fetch` the global `fetch`, and it serialises a FormData itself, taking
  strings and Blobs only: the `{ uri, name, type }` part that names the recorded file
  throws "Unsupported FormDataPart implementation" before anything is sent, which the run
  reads as a network failure and queues, for ever. React Native's own XMLHttpRequest hands
  the part to RCTNetworking (iOS) or OkHttp (Android), which stream the file from disk.
  `postClipForm` in `clip-upload.ts` takes that path on a phone and the browser's `fetch`
  on the web (where the part is the picked File); `clip-upload.test.ts` runs Expo's own
  serialiser on the part `uploadClip` builds, so it fails once Expo learns to send one.
  Every other call is JSON and goes through `fetch`.
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
- **The website's account is the kit, mounted between the Origin gate and the bearer
  gate.** `account.ts` hands every path below `APP_URL`'s path and `api/` to
  `apps/server/kit` (createApp's `handle`), from a middleware registered after the Origin
  gate, so a foreign Origin is refused there as everywhere, and before the `APP_TOKEN`
  gate, which none of its callers could pass: Google sends the browser back by a
  navigation, Stripe posts from its own servers, and the page keeps the token in memory
  only. The kit has its own authentication (a signed sign-in cookie and state, a session
  cookie and an Origin check on every write, Stripe's signature) and spends no Claude
  budget. The page's writes carry the site's Origin, so with sign-in on `CORS_ORIGIN` must
  be `APP_URL`'s origin: `accountProblem` stops the server otherwise, as `CORS_ORIGIN=*`
  does. The session is a cookie of the website's origin, so the site's reverse proxy puts
  `/api/` there (`deploy/nginx.conf`, `location ^~ /api/`); the server serves no site.
  Records live in `KIT_DATA_DIR`, the kit's file store: one process per directory, and the
  image's on the compose volume `account`. The request log prints no query string, since
  the sign-in's callback carries Google's one-time code. The daily cap is untouched: clips
  are still billed to `caller()`. The kit is never edited here (`kit_requests` go to the
  canonical copy), and `npm test` runs its self-test before the server's tests.
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
- **Bound the form before it is parsed, not only its size.** The parser behind
  `parseBody` spends a native search on a file's bytes but JavaScript objects on every
  part, header line and urlencoded pair, in one synchronous run: within the 80 MB cap,
  a body of nothing but tiny fields held the event loop for 7 to 15 s, and was answered
  "missing `clip`" before it spent a unit of the daily cap or a clip of the session, so
  it could be repeated for ever. `receiveClip` therefore takes `multipart/form-data`
  alone (415 otherwise), with the boundary read only where it has one reading
  (`clipFormBoundary`), and `clipFormProblem` counts every `CRLF--boundary` in the body
  (a superset of the parts the parser can make; at most `MAX_FORM_PARTS`) and requires
  a blank line within `MAX_PART_HEADER_BYTES` of each (the parser reads a part's headers
  no further than that). `form.test.ts` holds the bound against Node's real parser with
  a fuzz that reaches it from both sides; a scan that skips a delimiter inside a header
  block passes every hand-written case and fails that one.
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

## Settings

Every record the app keeps on the device is named once, in `KEYS` in
`apps/mobile/src/settings.ts`: `tvsham.settings.v1` (preferences and the server URL),
`tvsham.library.v1` and `tvsham.history.v1` (the user's own lists), `tvsham.device.v1`
(the per-install id), `tvsham.queue.v1` (clips waiting for the server), all in
AsyncStorage, `tvsham.token.v1` in expo-secure-store, and on the website alone
`tvsham.checkout.v1` in sessionStorage (the accent pack sent to Checkout, read once on the way
back to name it in the thank-you; it unlocks nothing).
`settings-contract.test.ts` pins the table, the row list, the enum tables and
`PREFERENCE_FIELDS` as literals, and greps the screens for a key string, a direct
`expo-haptics` import or a bare `Alert.alert`: a renamed key orphans every user's record
without any other test noticing. The validator is `cleanSettings(raw, fallback)` in the
same module - enum tables typed `Record<Union, true>`, own-property lookups only, and
the settings in force as the fallback so one bad field costs one field, never the
record; `store.ts` is the only reader and writer and goes through it on hydrate and on
every update. Its test walks `Object.getOwnPropertyNames(Object.prototype)` through
every enum field, built with `JSON.parse` so `__proto__` is an own key, and its
round-trip iterates literal lists rather than the exported name arrays, which derive
from the tables under test and would drop a member with them. The rows are Appearance
(`appearance`; `system` resolves to dark when the OS states no preference), Accent,
Vibration (`haptics`: a module flag in `feedback.ts` that the store sets, and every
haptic is a named moment there), Reduce motion (`reduceMotion`, three-state:
`useReduceMotion` in `motion.tsx` resolves `system` through `AccessibilityInfo`, and the
pure `shouldReduceMotion` sits beside the validator) and Reset to defaults, which is
confirmed and puts back exactly `PREFERENCE_FIELDS` - the server address, the token and
the unlocked accents are connection configuration and purchases, not preferences.
Confirmations go through `confirm.ts` (`window.confirm` on the web, `Alert.alert`
elsewhere, because react-native-web's `Alert` is an empty stub), and the rule for when
to ask is that the action destroys what the app cannot restore from inside itself:
removing a saved item and clearing the recent list. The version in the "How it works"
card is `Constants.expoConfig?.version` from `expo-constants`.

## Website

The app is also a website (README, "Run it as a website"). `scripts/build-web.mjs` runs
`expo export --platform web --clear` with `TVSHAM_SERVER_URL` (required) and `WEB_BASE_URL`
(optional), which `app.config.js` turns into `extra.serverUrl` and `experiments.baseUrl`
(app.json comes through untouched when neither is set), then fills `TVSHAM_SERVER_ORIGIN`
and `%BASE_URL%` into the `STAMPED` files (`404.html`, `_headers`, `.htaccess`), writes the
policy into the built `index.html` as a `<meta>` from `_headers` and moves its `site.css`
and `guard.js` under the base path (`finishPage`), and refuses to finish with either token
left. `public/index.html` carries neither the policy nor a token: `expo start --web` serves
it as it is, and with them the page asked for `/%BASE_URL%/guard.js` and refused the
development server's own reload socket, error overlay and address, so it never started.
`TVSHAM_SERVER_URL` must be `https:` unless it is loopback (`siteServerUrlFrom`): the policy
upgrades the page's requests, and an https page may not call an http server. `--clear` is
load-bearing: Metro's transform cache does not key on the app config, and without it a second
build kept the first one's server address under a policy that named another. The token is not a valid
CSP source, so a site published without the build has, in effect, `connect-src 'none'`.

- **One policy, five places**: `public/_headers`, `public/.htaccess`, `deploy/nginx.conf`,
  the `<meta>` the build writes into the built `index.html` from `_headers` (less
  `frame-ancestors`) and the README's table.
  `src/website.test.ts` holds them equal and pins every source; `e2e/web.mjs` loads the
  build under `_headers` against a real server and fails on any violation, console error,
  page error or request leaving the site. Each value was measured there by removing it:
  `media-src blob:` (the picker reads a video's length through a `<video>`), each `img-src`
  host (the result's pictures), `'self'` (the favicon and the header's back icon) and the
  empty-string hash all fail the suite when dropped. A picture host added to `resolve.ts`
  or `tmdb.ts` goes into all five. `connect-src` is `'self'` (the site's own `api/`: the
  account and the shop, which the server answers through the site's proxy) and the
  recognition server's origin, nothing else; Google and Stripe are top-level navigations,
  which CSP does not govern, so nothing else changed for them.
- **No `'unsafe-inline'`.** react-native-web inserts an empty `<style>` and fills it with
  `insertRule`, which CSP does not govern, so the hash of the empty string is all
  `style-src` needs beyond `'self'`. Nothing inline goes into `index.html` or `404.html`:
  `site.css` and `guard.js` are files for that reason, and Trusted Types are enforced.
- **On the web the server is the built one** (`pinServer` in `store.ts`, on hydrate and on
  every update; Settings shows it read-only): a stored address from an earlier build is one
  the policy refuses. **The token is memory only** (`TOKEN_IS_SAVED`): expo-secure-store has
  no web implementation and `localStorage` is readable by every script on the origin.
- **The account and the shop are the site's own `api/`.** `account.ts` asks `api/config`
  once at start (5 s at most) and, when sign-in is on, `api/me`; a 404, an error or a body
  that is not the kit's is no account, and nothing more is asked, drawn or stored. On a host
  with nothing at `api/` that one 404 is a console line Chromium logs (the browser suite
  counts it by its address). An accent the shop sells is drawn and chosen only once `api/me`
  says it is owned, and Midnight until then (`drawnAccent`, `canUseAccent`); the record's
  `unlockedAccents` is not read for it, and not written. While `api/` is being asked,
  Midnight alone. The kit's `?signin=failed` and `?purchase=…` arrive at the first screen and
  are taken out by the router (`useLandingCleared`): Expo Router writes the address from its
  own state, so `history.replaceState` alone was written over when it mounted and on every
  navigation back (measured). The browser suite signs in, buys, posts the signed webhook,
  signs out and deletes; it answers Google's step by handing the browser the kit's 302 as a
  `Refresh`, because Playwright routes no request a redirect makes.
- **What a browser cannot do says so**: camera recording (expo-camera's web `recordAsync`
  answers an empty file) is `WebCameraNotice`; the offline queue (expo-file-system has no
  web implementation) is off (`CAN_QUEUE`), so a failed upload is an error card that says
  the server was not reached and the video has to be chosen again (`unsentMessage`, not the
  browser's "Failed to fetch"; the browser suite stages it); a picked
  File is held in `web-clips.ts` for its upload, because fetching its `blob:` address back
  would need `blob:` in `connect-src`, and is released when the run ends.
- Every route in `app/` is served as the one page by every host (`_redirects`,
  `.htaccess`, `nginx.conf`, and a cache rule in `_headers`); the website test reads `app/`
  and fails when one is missing. Each path gets `Cache-Control` from one `_headers` rule,
  because Netlify and Cloudflare join a header two rules set. A `_headers` rule matches the
  address whatever answers it, so a missing name under `/_expo/static/` is a 404 marked
  immutable there (the browser suite's host does the same); those hosts publish a deploy
  whole. nginx and Apache, which a site is copied to file by file, answer one with no-cache
  because the lifetime is chosen by the not-found page's address (`map $uri` after
  `error_page 404`, the `<If>` on REQUEST_URI after `ErrorDocument 404`): measured on nginx
  1.24 and Apache 2.4.58, and pinned by the website test. `_redirects` refuses the hosting
  files with `404!`: Netlify applies a rule without the `!` only where no file exists, and
  `e2e/serve.mjs` does the same. Cloudflare Pages takes no 404 rule and serves `.htaccess`
  as a file (it holds the public headers and the server's origin).
- The server's side is `API_HEADERS` in `apps/server/src/index.ts`, set by the outermost
  middleware twice: on the context before the rest runs, because @hono/node-server builds a
  HEAD's response from the GET one's original headers (set only afterwards, `curl -I` showed
  none), and on the finished response for a Response a handler builds itself, which Hono
  passes on without the context's headers. The account's mount answers that way (every
  answer is a Response the kit builds), so there the second pass is what sends them, and the
  server's `Cache-Control: no-store` and policy replace the kit's own (its `api/config` would
  otherwise be cacheable for a minute); `index.test.ts` drives `apiHeaders` with handlers
  that build their own and checks every kind of answer the server gives and the README,
  `account.test.ts` and `http-headers.test.ts` check them over a real socket through the
  adapter, and the browser suite checks the preflight, the site's calls and the account's.
- `.well-known/security.txt` expires on 2027-10-08 and the website test fails once it has:
  renew it, a year ahead at most. Its `Contact` is the issues page, because private
  vulnerability reporting is switched off on the repository (SECURITY.md says to open an
  issue with no details in it), and its `Policy` is SECURITY.md on `main`: the default
  branch does not carry it yet, so `blob/HEAD` answered 404.

## Native configuration

**app.json states every native key the config test pins, even at its default**
(`src/app-config.test.ts`, which runs `expo config --type introspect` and checks the
merged manifest and plist, not only the file). On SDK 57 `newArchEnabled` has no reader
and `android.edgeToEdgeEnabled` makes prebuild warn that edge-to-edge is mandatory -
the `--json` introspect swallows that warning, so neither key may come back.
`userInterfaceStyle` lives at the top level once and needs `expo-system-ui` to do
anything on Android; the test proves the module is wired in by the
`RCTRootViewBackgroundColor` only its plugin writes. `allowBackup` is true on purpose:
the library and history are the user's own record, and `plugins/withBackupRules.js`
writes the app's own rules - `res/xml/backup_rules.xml` for Android 11 and lower,
`data_extraction_rules.xml` (cloud backup and device transfer, each its own section)
for 12 and higher: the `database` domain, where AsyncStorage keeps its `RKStorage`
SQLite file, and `sharedpref` are included, and expo-secure-store's `SecureStore.xml`
is excluded, so the token stays on the device (its Android Keystore key never leaves
it either). They are the app's own because expo-secure-store's plugin writes rules
that include `sharedpref` alone, and once a rule file has an `<include>` Android
backs up nothing else - listing that plugin, as 88f9d7e did, excluded the database
and with it everything the user would miss, while claiming the opposite. The plugin
stays listed with `configureAndroidBackup: false`, so it neither writes its rules nor
warns that others are present, and `faceIDPermission: false`, which keeps its default
Face ID string out of the plist. The mod that writes the files is a dangerous mod,
which introspect does not run, so the config test drives it against a temp directory
and parses what it wrote, and reads the two file names out of the modules' own
sources. `blockedPermissions` holds exactly one entry,
SYSTEM_ALERT_WINDOW: the template grants it for the dev-menu overlay and its debug
source set re-declares it, so a dev client loses nothing and a release build stops
carrying 'display over other apps'. INTERNET is deliberately *not* blocked - this app
talks to the user's server - and the test pins the block as exactly that list and
ratchets the merged permission set to an accounted-for one. The adaptive icon is three
generated layers from `scripts/make-icons.mjs`; the monochrome one is alpha-only
because `render()` truncates floats and a themed icon reads only alpha anyway. Run
`node scripts/make-icons.mjs` after touching the glyph; the tracked PNGs are reproduced
byte for byte.

## Conventions

This repository follows `CONVENTIONS.md`, which is identical in every platteration
repository and pinned by the conventions test (`npm run test:conventions`, or
`tests/test_conventions.py` in a Python repository): the script set (`test`,
`typecheck`, `lint`, `check`, `test:e2e`, `test:all`), Node 22 via `.nvmrc`, one
`.editorconfig`, ESLint per stack, the `ci.yml` shape, the documents every repository
carries and the README skeleton. The repository's check command (`npm run check`, or
`ruff check .` then `pytest -q` in a Python repository) is the gate before a push. To
change a convention, change it in every repository in one pass and update the hashes in
the test.
