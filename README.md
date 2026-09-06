# TVsham

**Shazam, but for video.** Point your phone at a TV, or share a screen recording from your phone, and after a few seconds TVsham tells you what you're watching and hands you the link:

- a **movie**, **TV show** or **specific episode** → the Wikipedia article (episode article when one exists)
- a **YouTube video / Short**, **TikTok**, **Reel** → the YouTube link, opened straight in the YouTube app
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

### Server configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | – | **Required.** |
| `CLAUDE_MODEL` | `claude-opus-5` | Recognition model. |
| `PORT` | `8787` | Listen port. |
| `APP_TOKEN` | – | If set, the app must send it as a bearer token (enter it in Settings). |
| `STT_PROVIDER` | `none` | `whisper-http` posts the audio to an OpenAI‑style `/v1/audio/transcriptions` endpoint (hosted or self‑hosted whisper). Adds dialogue to the evidence, which matters most for identifying *episodes*. |
| `STT_URL`, `STT_API_KEY`, `STT_MODEL` | – | Settings for `whisper-http`. |
| `YOUTUBE_API_KEY` | – | Optional YouTube Data API v3 key for a proper search fallback. Without it, direct links are still verified via oEmbed. |
| `WIKIPEDIA_LANG` | `en` | Wikipedia edition for article lookups. |
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

- **Point at a TV** – full‑screen camera. Tap *Identify*; the app records 8‑second clips at 480p and keeps going until the server is confident or you tap stop. Get dialogue or on‑screen text (subtitles, a title card, a channel name) in frame for the best results.
- **My screen** – iOS does not let third‑party apps capture other apps' screens (that needs a Broadcast Upload Extension), so both platforms use the OS screen recorder: record with the system control, then pick the recording in the app. The server analyses up to the first 60 seconds. Titles, captions and channel names in the UI make this mode very accurate for YouTube, Shorts, TikTok and Reels.

### Result and library

The result screen shows what it found, how sure it is, the evidence, and the links: Wikipedia opens in an in‑app browser, YouTube links open in the YouTube app when installed. *Save for later* stores the result on the device (no account needed); the *Saved* screen lets you open, mark watched, or remove items.

## Development

```bash
npm run typecheck     # all workspaces
npm test              # server unit tests (ffmpeg pipeline, link resolution, HTTP routes)
```

CI (`.github/workflows/ci.yml`) runs the typecheck, the server tests, a Metro bundle of the app, and a Docker build of the server.

## Roadmap / known limits

- Android in‑app screen capture (MediaProjection) and an iOS Broadcast Upload Extension so "My screen" doesn't need the system recorder.
- Share‑sheet target so a screen recording can be sent to TVsham directly from the recorder's notification.
- Speech‑to‑text is optional today; on‑screen text and visuals alone identify most content, but dialogue is the strongest signal for picking the exact episode of a long‑running show.
- Recognition costs one Claude request per clip (frames + a few web searches). Sessions cap at four clips.
