# TVsham

**Shazam, but for video.** Point your phone at a TV, or share a screen recording from your phone, and after a few seconds TVsham tells you what you're watching and hands you the link:

- a **movie**, **TV show** or **specific episode** → the Wikipedia article (episode article when one exists), plus where to stream, rent or buy it and who is in it
- a **YouTube video / Short**, **TikTok**, **Reel** → a link on the video's own platform, opened straight in that app, plus the creator's profile
- anything you want to keep → **Save for later** in the app's library, mark as watched when you're done

iOS and Android, built with Expo (React Native). Recognition runs on a small Node server you host yourself.

```
┌──────────────────────┐   8 s clips (480p mp4)   ┌──────────────────────────────┐
│  TVsham app          │ ───────────────────────▶ │  TVsham server               │
│  · camera → record   │                          │  · ffmpeg: frames + audio    │
│  · screen → pick     │ ◀─────────────────────── │  · (optional) speech-to-text │
│  · result / library  │   identification + links │  · Claude + web search       │
└──────────────────────┘                          │  · Wikipedia / YouTube       │
                                                  └──────────────────────────────┘
```

## How recognition works

There is no public fingerprint database for TV and film the way there is for music, so TVsham works the way a person would:

1. The app records an 8‑second clip (camera) or takes the screen recording you picked.
2. The server pulls 6–12 evenly spaced frames out of it with ffmpeg, plus a 16 kHz mono audio track.
3. If a speech‑to‑text provider is configured, the audio becomes a transcript of the dialogue.
4. Claude looks at the frames (on‑screen titles, captions, channel names, faces, sets, app UI) and the transcript, and uses **web search** to verify: a quoted line of dialogue usually pins down the exact episode; a title plus channel pins down the YouTube video.
5. The server verifies the answer against Wikipedia's API (article summary, thumbnail) or YouTube's oEmbed (title, channel, thumbnail) so the link you get is real, and falls back to a search link when it isn't sure.
6. If confidence is low, the app keeps listening. While one clip is being analysed the next is already recording, up to four clips (~32 s). Every clip is deleted from the server as soon as it has been analysed.

### Attribution

Where-to-watch and cast data come from TMDB when `TMDB_API_KEY` is set. This product uses the TMDB API but is not endorsed or certified by TMDB.

## Repository layout

```
apps/mobile      Expo app (expo-router, expo-camera, expo-image-picker)
apps/server      Node 22 + Hono server (ffmpeg, @anthropic-ai/sdk)
packages/shared  Types shared by both (Identification, RecognitionResult, ...)
```

## Run the server

Requirements: Node 20+, an Anthropic API key. ffmpeg is bundled via `ffmpeg-static`; a system `ffmpeg` on `PATH` is used when present.

```bash
npm install
cp apps/server/.env.example apps/server/.env      # add ANTHROPIC_API_KEY
npm run server                                    # http://localhost:8787
```

Or with Docker (ffmpeg included):

```bash
docker compose up --build
```

Check it: `curl http://localhost:8787/health` →

```json
{ "ok": true, "version": "0.1.0", "ffmpeg": true, "stt": "none", "model": "claude-opus-5" }
```

### Deploying safely

- Set `APP_TOKEN` whenever the server is reachable beyond your own LAN: every clip costs Claude API money, and without a token anyone who finds the port can spend it. The server warns at startup when it is unset.
- Set `DAILY_CLIP_LIMIT` if the server is public. The app sends a random per-install id (`X-Device-Id`) that the cap counts against; callers without one are counted by address. It identifies the install and nothing about the person.
- Put TLS in front of it (a reverse proxy or your host's ingress); the app talks plain HTTP to whatever URL you give it.
- Uploads are capped at 80 MB and rejected before they are buffered; clips are deleted right after analysis; the Docker image runs as the unprivileged `node` user; internal error details stay in the server log when `NODE_ENV=production`.

### Server configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | – | **Required.** |
| `CLAUDE_MODEL` | `claude-opus-5` | Recognition model. |
| `PORT` | `8787` | Listen port. |
| `APP_TOKEN` | – | If set, the app must send it as a bearer token (enter it in Settings). |
| `MAX_CONCURRENT` | `3` | Clips analysed in parallel across all sessions; the rest queue. |
| `DAILY_CLIP_LIMIT` | `0` (off) | Clips one device may have analysed per day. In-memory, so it resets on restart. |
| `FIRST_PASS_MODEL` | – | Cheaper model for a first pass; the main model re-reads the same evidence only when that answer is not confident. |
| `STT_PROVIDER` | `none` | `whisper-http` posts the audio to an OpenAI‑style `/v1/audio/transcriptions` endpoint (hosted or self‑hosted whisper). Adds dialogue to the evidence, which matters most for identifying *episodes*. |
| `STT_URL`, `STT_API_KEY`, `STT_MODEL` | – | Settings for `whisper-http`. |
| `YOUTUBE_API_KEY` | – | Optional YouTube Data API v3 key for a proper search fallback. Without it, direct links are still verified via oEmbed. |
| `WIKIPEDIA_LANG` | `en` | Wikipedia edition for article lookups. |
| `TMDB_API_KEY` | – | Optional TMDB key. Adds "where to watch" and a cast list to film and TV results. |
| `WATCH_REGION` | `US` | Country for watch providers when the app sends none; the app sends the device's own. |
| `FFMPEG_PATH` | auto | Explicit ffmpeg binary. |

### API

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/health` | – | `HealthResponse` |
| `POST` | `/sessions` | `{ "source": "camera" \| "screen" }` | `{ sessionId }` |
| `POST` | `/sessions/:id/clips` | multipart, field `clip` (mp4/mov/webm) | `RecognitionResult` for *all* clips so far |
| `GET` | `/sessions/:id` | – | last `RecognitionResult` |
| `DELETE` | `/sessions/:id` | – | 204 |

`RecognitionResult.status` is `listening` (send another clip), `identified`, `unsure` (best guess after the clip limit) or `failed`. See `packages/shared/src/index.ts` for the full shapes.

## Run the app

```bash
npm run mobile            # starts Metro; scan the QR with Expo Go, or press i / a
```

Expo Go is enough for development: the camera, microphone and photo picker all work there. In Settings, enter your server's URL (on a LAN, the app pre‑fills the Metro host with port 8787).

For device builds, `npx expo prebuild` then `npx expo run:ios` / `npx expo run:android`, or use EAS with the profiles in `apps/mobile/eas.json` (`eas build --profile preview --platform android` gives an installable APK). The icon and splash assets are generated by `node scripts/make-icons.mjs`; edit that script to restyle them.

### Modes

Both modes take an optional one-line hint ("90s sitcom", "on Netflix"). Anything you already know narrows the search, which matters most for long-running shows.

- **Point at a TV** – full‑screen camera. Tap *Identify*; the app records 8‑second clips at 480p and keeps going until the server is confident or you tap stop. Get dialogue or on‑screen text (subtitles, a title card, a channel name) in frame for the best results.
- **My screen** – iOS does not let third‑party apps capture other apps' screens (that needs a Broadcast Upload Extension), so both platforms use the OS screen recorder: record with the system control, then pick the recording in the app. The server analyses up to the first 60 seconds. Titles, captions and channel names in the UI make this mode very accurate for YouTube, Shorts, TikTok and Reels.

### Look and feel

Dark by default, with a full light palette that follows the system or can be pinned in Settings, and four accent packs. While a clip is being taken, sonar rings pulse out of the capture button and the button breathes, so the wait reads as listening rather than hanging; corner brackets frame where to point. Results lead with a confidence ring (green, amber, red) instead of a bare percentage, over a poster backdrop blurred to fill the card. All animation is native-driven so the camera preview stays smooth.

Colours live in one palette (`src/theme.tsx`); screens build their styles through `makeStyles`, so both schemes and every accent stay consistent without per-screen overrides. `Settings.unlockedAccents` gates which packs are selectable; today every pack ships unlocked, and that field is where a cosmetics purchase would hook in.

### When the server is out of reach

A clip that cannot be uploaded is kept rather than lost: it is moved out of the cache into the app's own storage and queued, up to ten clips. The capture screen shows how many are waiting, and the queue is retried whenever the app comes back to the foreground or you tap *Try now*. This is what makes the app usable on a plane or in a dead zone: record now, get the answer when there is a connection.

### Result and library

The result screen shows what it found, how sure it is, the evidence, and the links: Wikipedia opens in an in‑app browser, YouTube links open in the YouTube app when installed. *Save for later* stores the result on the device (no account needed). The *Saved* screen lists saved items (open, mark watched, remove) and a *Recent* section with the last 30 identifications, so a result you dismissed can still be opened or saved.

## Development

```bash
npm run typecheck     # all workspaces
npm test              # server unit tests (ffmpeg pipeline, link resolution, HTTP routes)
```

CI (`.github/workflows/ci.yml`) runs the typecheck, the server tests, a Metro bundle of the app, and a Docker build of the server.

## Roadmap / known limits

Everything below needs a device build or an outside relationship to do properly, so none of it is stubbed in the app: a half-built version would be worse than its absence.

**Needs a native build to develop against**

- **Share-sheet target.** Sending a screen recording or a pasted link straight into TVsham from the recorder's notification. Needs a share-intent config plugin and a custom dev client, so it cannot be built or checked under Expo Go.
- **In-app screen capture.** Android MediaProjection and an iOS Broadcast Upload Extension would remove the "record, then pick the file" step. The extension in particular is a separate build target with its own memory limits.
- **Song in this scene.** ShazamKit is free on Apple platforms but needs a native module; the server already extracts the audio it would use.
- **Lock-screen and widget capture.** An iOS Control Center control and an Android Quick Settings tile. Speed is the point of this app, so this is the highest-value native item.

**Needs something outside the code**

- **Affiliate revenue.** TMDB's terms only permit linking to their own watch page, which is what the app does. Per-click revenue would mean a direct relationship with each streaming or rental service.
- **Purchases.** The pieces a store would attach to already exist: `Settings.unlockedAccents` gates the accent packs, and `DAILY_CLIP_LIMIT` enforces a per-device ceiling server-side. What is missing is receipt validation, which needs a real store account. Two things worth not building: ads on the result screen, which would spoil the one moment the app exists for, and paywalling an answer after the clip was recorded, which reads as a ransom.
- **Sync and export.** A cloud watchlist, or one-tap export to Trakt, Letterboxd or Notion. The library is device-only today and each export target is its own OAuth integration.

**Open questions**

- **Timestamp inside an episode.** Matching the transcript against subtitle files could say "you are 23 minutes into S3E7". Memorable, but it needs a subtitle corpus and licensing to match against.
- **Speech-to-text is off by default.** Visuals and on-screen text identify most content; dialogue is the strongest signal for picking the exact episode of a long-running show. Turning `STT_PROVIDER` on costs another service per clip.
- **The cost cascade is unmeasured.** `FIRST_PASS_MODEL` should cut the per-identification cost substantially, but nobody has run it against a set of real clips yet. Build that eval before trusting it.

## Cost

Recognition is one Claude request per clip, with frames and a few web searches, so a session of one to four clips is the unit that costs money. That shapes everything above: an unmetered public server is an open tab, which is why `DAILY_CLIP_LIMIT` and `APP_TOKEN` exist.
