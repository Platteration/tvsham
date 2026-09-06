import path from "node:path";

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  port: Number(env("PORT", "8787")),
  appToken: env("APP_TOKEN"),
  model: env("CLAUDE_MODEL", "claude-opus-5")!,
  tmpDir: path.resolve(env("TMP_DIR", "./tmp")!),
  ffmpegPath: env("FFMPEG_PATH"),
  stt: {
    provider: env("STT_PROVIDER", "none")! as "none" | "whisper-http",
    url: env("STT_URL", "https://api.openai.com/v1/audio/transcriptions")!,
    apiKey: env("STT_API_KEY"),
    model: env("STT_MODEL", "whisper-1")!,
  },
  youtubeApiKey: env("YOUTUBE_API_KEY"),
  /** Wikipedia edition used for article lookups. */
  wikipediaLang: env("WIKIPEDIA_LANG", "en")!,
  /** Frames sampled per clip. */
  framesPerClip: 6,
  /** Longest slice of a single upload we look at, in seconds. */
  maxClipSeconds: 60,
  /** Max upload size in bytes. */
  maxUploadBytes: 80 * 1024 * 1024,
  /** Sessions idle longer than this are dropped. */
  sessionTtlMs: 15 * 60 * 1000,
  version: "0.1.0",
} as const;
