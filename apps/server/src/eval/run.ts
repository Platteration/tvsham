/**
 * Run a folder of labelled clips through the recognition pipeline and report how
 * it did. This is the measurement FIRST_PASS_MODEL needs before anyone trusts it:
 * run it once per model and compare.
 *
 *   npx tsx src/eval/run.ts --clips ./eval-clips
 *   npx tsx src/eval/run.ts --clips ./eval-clips --model claude-sonnet-5
 *
 * `--clips` must contain the video files and a labels.json:
 *
 *   [{ "file": "breaking-bad-s5e14.mp4", "kind": "tv_episode",
 *      "title": "Breaking Bad", "season": 5, "episode": 14 }]
 *
 * Every run costs real money: one Claude request per clip, plus web searches.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIN_USEFUL_CONFIDENCE } from "@tvsham/shared";
import { config } from "../config.js";
import { extractAudio, extractFrames, ffmpegBinary, probeDuration } from "../media.js";
import { recognise, type Evidence } from "../recognize.js";
import { sttProvider } from "../stt.js";
import { formatReport, score, type ClipLabel, type ScoredClip } from "./score.js";

interface Options {
  clipsDir: string;
  model: string;
  minConfidence: number;
  /** Analyse at most this many clips; handy for a cheap smoke run. */
  limit: number;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    clipsDir: path.resolve(get("--clips") ?? "./eval-clips"),
    model: get("--model") ?? config.model,
    minConfidence: Number(get("--min-confidence") ?? MIN_USEFUL_CONFIDENCE),
    limit: Number(get("--limit") ?? Number.POSITIVE_INFINITY),
  };
}

async function readLabels(dir: string): Promise<ClipLabel[]> {
  const raw = await fs.readFile(path.join(dir, "labels.json"), "utf8");
  const parsed = JSON.parse(raw) as ClipLabel[];
  if (!Array.isArray(parsed)) throw new Error("labels.json must be an array of clip labels");
  return parsed;
}

/** One clip through the same steps the server uses for an uploaded clip. */
async function analyse(clipPath: string, model: string): Promise<{ evidence: Evidence; seconds: number }> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "tvsham-eval-"));
  const started = Date.now();
  try {
    const duration = await probeDuration(clipPath);
    const looked = Math.min(duration || config.maxClipSeconds, config.maxClipSeconds);
    const frameCount = Math.min(12, Math.max(config.framesPerClip, Math.round(looked / 4)));
    const [frames, wav] = await Promise.all([
      extractFrames(clipPath, { count: frameCount, maxSeconds: config.maxClipSeconds, workDir }),
      extractAudio(clipPath, { maxSeconds: config.maxClipSeconds, workDir }),
    ]);
    const transcript = wav ? await sttProvider().transcribe(wav) : null;
    return {
      evidence: {
        source: "camera",
        frames: frames.map((f) => ({ ...f, clip: 0 })),
        transcripts: [transcript ?? ""],
      },
      seconds: (Date.now() - started) / 1000,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!(await ffmpegBinary())) throw new Error("ffmpeg not found. Install it or set FFMPEG_PATH.");
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("Set ANTHROPIC_API_KEY: every clip in this run calls the API.");
  }

  const labels = (await readLabels(opts.clipsDir)).slice(0, opts.limit);
  console.log(`Running ${labels.length} clip(s) on ${opts.model}. This calls the API once per clip.\n`);

  const scored: ScoredClip[] = [];
  for (const label of labels) {
    const clipPath = path.join(opts.clipsDir, label.file);
    process.stdout.write(`  ${label.file} … `);
    try {
      const started = Date.now();
      const { evidence } = await analyse(clipPath, opts.model);
      const identification = await recognise(evidence, { model: opts.model });
      const verdict = score(label, identification, opts.minConfidence);
      scored.push({
        label,
        identification,
        verdict,
        confidence: identification.confidence,
        seconds: (Date.now() - started) / 1000,
      });
      console.log(verdict);
    } catch (err) {
      console.log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${formatReport(scored, opts.model)}`);
  const outPath = path.join(opts.clipsDir, `results-${opts.model}-${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(scored, null, 2));
  console.log(`\nFull results: ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
