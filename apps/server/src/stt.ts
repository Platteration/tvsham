import { promises as fs } from "node:fs";
import { config } from "./config.js";

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
    const body = new FormData();
    const bytes = await fs.readFile(wavPath);
    body.set("file", new Blob([bytes], { type: "audio/wav" }), "audio.wav");
    body.set("model", config.stt.model);
    body.set("response_format", "json");
    const headers: Record<string, string> = {};
    if (config.stt.apiKey) headers.Authorization = `Bearer ${config.stt.apiKey}`;
    const res = await fetch(config.stt.url, { method: "POST", headers, body });
    if (!res.ok) {
      console.warn(`[stt] ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as { text?: string };
    const text = json.text?.trim();
    return text ? text : null;
  },
};

export function sttProvider(): SttProvider {
  switch (config.stt.provider) {
    case "whisper-http":
      return whisperHttp;
    default:
      return none;
  }
}
