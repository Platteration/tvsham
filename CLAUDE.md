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
  Claude, `resolve.ts` Wikipedia/YouTube, `stt.ts` optional speech-to-text, `sessions.ts`
  in-memory session store.
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

## Things that trip people up

- Never import a colour constant directly: use `useTheme()` for inline colours and
  `makeStyles((c) => ...)` for stylesheets, or the screen will be stuck in one scheme.

- iOS ignores `videoQuality` on `recordAsync` unless a `codec` is passed.
- expo-router 57 vendors react-navigation; import `ThemeProvider`/`DarkTheme` from
  `expo-router`, not `@react-navigation/native`.
- `expo install` needs network to Expo's API; pin versions from
  `node_modules/expo/bundledNativeModules.json` when offline.
