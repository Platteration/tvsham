# TVsham – notes for Claude Code

"Shazam for video": an Expo app records a few seconds of a TV (camera) or takes a screen
recording, a Node server extracts frames + audio with ffmpeg, Claude identifies the
content with web search, and the server returns verified Wikipedia / YouTube links.

## Layout

- `apps/mobile` – Expo SDK 57, expo-router. Screens in `app/`, logic in `src/`
  (`useIdentify.ts` is the record → upload → repeat loop; `store.ts` holds settings and the
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
  `settings.ts`, `format.ts`, `queue-policy.ts`); the `.tsx` files then hold only
  rendering. That is what makes `npm test` possible in `apps/mobile` at all.
- Colour changes must keep `palette.test.ts` green: it checks every text pairing in
  both schemes and all four accents against WCAG AA.

## Invariants worth not breaking

These each came from a reproduced bug or a security finding; a change that undoes one
will pass typecheck and tests but reopen the hole.

- **Bill callers by something they cannot choose.** `caller()` in `index.ts` uses the
  socket address, not a header. Counting `X-Device-Id` or an untrusted
  `X-Forwarded-For` lets anyone reset the daily cap by editing a header.
- **Re-check per-session limits inside the `s.busy` chain**, not at request entry:
  `s.clips` only moves inside `processClip`, so an entry check lets concurrent uploads
  all through.
- **Every ffmpeg run needs a timeout and a size budget.** The input is attacker-supplied;
  a 424 KB file can declare 16000x9000 and cost gigabytes to decode one frame.
- **Cap the frames carried in `s.evidence`.** Each clip re-sends the whole session, so
  without a ceiling the image tokens grow with the square of the clip count.
- **Untrusted text (transcripts, hints, model write-ups) is fenced with a per-request
  random delimiter.** A fixed fence can be closed by the content itself.
- **The app checks a URL is http(s) before opening or rendering it** (`isSafeWebUrl`).
  The server is reached over plain HTTP by default, and Android will launch another app
  from an `intent://` URL.
- **CORS stays off unless `CORS_ORIGIN` is set.** The app is not a browser; permissive
  headers would let any web page spend the operator's Claude budget.

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
