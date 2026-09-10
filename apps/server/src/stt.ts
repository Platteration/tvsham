import { promises as fs } from "node:fs";
import { config } from "./config.js";
import { postForm } from "./http.js";

/**
 * Optional speech-to-text. Claude reads frames, not audio, so dialogue only reaches the
 * recogniser if a transcription provider is configured. The default is "none".
 */
export interface SttProvider {
  readonly name: string;
  transcribe(wavPath: string): Promise<string | null>;
}

const none: SttProvider = {
  name: "none",
  async transcribe() {
    return null;
  },
};

/**
 * Any endpoint that speaks the OpenAI-style multipart `/v1/audio/transcriptions` contract.
 * Self-hosted whisper.cpp / faster-whisper servers expose the same shape.
 */
const whisperHttp: SttProvider = {
  name: "whisper-http",
  async transcribe(wavPath) {
    const url = config.stt.url;
    if (!url) return null;
    const body = new FormData();
    const bytes = await fs.readFile(wavPath);
    body.set("file", new Blob([bytes], { type: "audio/wav" }), "audio.wav");
    body.set("model", config.stt.model);
    body.set("response_format", "json");
    const headers: Record<string, string> = {};
    if (config.stt.apiKey) headers.Authorization = `Bearer ${config.stt.apiKey}`;
    try {
      // Through http.ts like every other outbound call: it carries the deadline,
      // and it is what tests replace instead of the global fetch.
      const res = await postForm(url, body, { headers, timeoutMs: config.stt.timeoutMs });
      if (!res.ok) {
        console.warn(`[stt] ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
        return null;
      }
      const json = (await res.json()) as { text?: string };
      const text = json.text?.trim();
      return text ? text : null;
    } catch (err) {
      // A missing transcript is a supported outcome — frames alone still
      // identify most clips — so a slow or broken endpoint must not fail the
      // clip that was uploaded.
      console.warn("[stt] transcription failed", err);
      return null;
    }
  },
};

export function sttProvider(): SttProvider {
  switch (config.stt.provider) {
    case "whisper-http":
      // Without a URL there is nowhere to send audio; sttWarning() explains it
      // and main() refuses to start, so this is only reached in tests.
      return config.stt.url ? whisperHttp : none;
    default:
      return none;
  }
}

/**
 * What is wrong with the speech-to-text configuration, in words, or null.
 * Turning transcription on without saying where audio should go used to fall
 * back to a hosted third party, which is not something to guess at.
 */
export function sttWarning(): string | null {
  if (config.stt.provider === "whisper-http" && !config.stt.url) {
    return "STT_PROVIDER=whisper-http needs STT_URL (for example http://127.0.0.1:8080/v1/audio/transcriptions). Audio is only ever sent to the address you name.";
  }
  return null;
}
