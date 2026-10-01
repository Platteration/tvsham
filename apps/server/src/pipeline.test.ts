import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import type { CreateSessionResponse, RecognitionResult } from "@tvsham/shared";
import { config } from "./config.js";
import { setFetchForTests } from "./http.js";
import { app } from "./index.js";
import { ffmpegBinary } from "./media.js";
import { setClientForTests } from "./recognize.js";

const execFileAsync = promisify(execFile);

/**
 * The whole upload path with only the two outside worlds faked: the model, and
 * the web. Everything between — ffmpeg, the session store, link resolution,
 * TMDB enrichment, the response shape — is the real thing. Unit tests cover
 * each of those alone; this is the wiring between them.
 */

const ANALYSIS = "KIND: tv_episode\nTITLE: Breaking Bad\nSEASON: 5\nEPISODE: 14";

const PARSED = {
  kind: "tv_episode",
  title: "Breaking Bad",
  year: 2013,
  season: 5,
  episodeNumber: 14,
  episodeTitle: "Ozymandias",
  creator: null,
  creatorHandle: null,
  platform: null,
  wikipediaTitle: "Breaking Bad",
  wikipediaEpisodeTitle: "Ozymandias (Breaking Bad)",
  youtubeUrl: null,
  videoUrl: null,
  confidence: 0.93,
  evidence: "Quoted dialogue matched the episode.",
  alternatives: [],
};

function fakeClaude(): { client: Anthropic; imagesSeen: () => number } {
  let images = 0;
  const client = {
    beta: {
      messages: {
        create: async (params: { messages: Array<{ content: unknown }> }) => {
          for (const m of params.messages) {
            if (Array.isArray(m.content)) {
              images += m.content.filter((b: { type: string }) => b.type === "image").length;
            }
          }
          return { stop_reason: "end_turn", content: [{ type: "text", text: ANALYSIS }] };
        },
      },
    },
    messages: { parse: async () => ({ parsed_output: PARSED }) },
  } as unknown as Anthropic;
  return { client, imagesSeen: () => images };
}

function fakeWeb(url: string | URL): Promise<Response> {
  const u = String(url);
  if (u.includes("/page/summary/Ozymandias_(Breaking_Bad)")) {
    return Promise.resolve(
      Response.json({
        title: "Ozymandias (Breaking Bad)",
        extract: "The fourteenth episode of the fifth season.",
        thumbnail: { source: "https://upload.wikimedia.org/oz.jpg" },
        content_urls: { mobile: { page: "https://en.m.wikipedia.org/wiki/Ozymandias_(Breaking_Bad)" } },
      }),
    );
  }
  if (u.includes("/page/summary/Breaking_Bad")) {
    return Promise.resolve(
      Response.json({
        title: "Breaking Bad",
        extract: "An American crime drama.",
        content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Breaking_Bad" } },
      }),
    );
  }
  if (u.includes("/search/tv")) return Promise.resolve(Response.json({ results: [{ id: 1396 }] }));
  if (u.includes("/watch/providers")) {
    return Promise.resolve(
      Response.json({
        results: { US: { link: "https://www.themoviedb.org/tv/1396/watch", flatrate: [{ provider_name: "Netflix", logo_path: "/n.jpg" }] } },
      }),
    );
  }
  if (u.includes("/credits")) {
    return Promise.resolve(Response.json({ cast: [{ id: 17419, name: "Bryan Cranston", character: "Walter White" }] }));
  }
  return Promise.resolve(new Response("", { status: 404 }));
}

describe("upload pipeline", () => {
  let dir = "";
  let clip: Buffer;
  const originalTmdb = config.tmdbApiKey;
  const claude = fakeClaude();

  before(async () => {
    const bin = await ffmpegBinary();
    assert.ok(bin, "ffmpeg is required for the pipeline test");
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tvsham-pipeline-"));
    const clipPath = path.join(dir, "clip.mp4");
    await execFileAsync(bin!, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=320x180:rate=12",
      "-f", "lavfi", "-i", "sine=frequency=440",
      "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", clipPath,
    ]);
    clip = await fs.readFile(clipPath);
    setClientForTests(claude.client);
    setFetchForTests(fakeWeb as typeof fetch);
    (config as { tmdbApiKey?: string }).tmdbApiKey = "test-key";
  });

  after(async () => {
    setClientForTests(null);
    setFetchForTests(null);
    (config as { tmdbApiKey?: string }).tmdbApiKey = originalTmdb;
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("turns an uploaded clip into a verified answer with links, watch options and cast", async () => {
    const created = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "camera", hints: "AMC drama", region: "us" }),
    });
    assert.equal(created.status, 201);
    const { sessionId, sessionKey } = (await created.json()) as CreateSessionResponse;

    const form = new FormData();
    form.set("clip", new Blob([clip], { type: "video/mp4" }), "clip.mp4");
    form.set("clipKey", "pipeline-1");
    const res = await app.request(`/sessions/${sessionId}/clips`, {
      method: "POST",
      headers: { "x-session-key": sessionKey },
      body: form,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as RecognitionResult;

    // The model actually saw frames pulled out of the clip.
    assert.ok(claude.imagesSeen() > 0, "frames must reach the model");

    assert.equal(body.status, "identified");
    assert.equal(body.wantsMore, false);
    assert.equal(body.analysing, false);
    assert.equal(body.identification?.title, "Breaking Bad");
    assert.deepEqual(body.identification?.episode, { season: 5, number: 14, title: "Ozymandias" });

    // The episode article first, then the show's, both verified against the web.
    assert.deepEqual(
      body.links.map((l) => [l.provider, l.confidence, l.title]),
      [
        ["wikipedia", "verified", "Ozymandias (Breaking Bad)"],
        ["wikipedia", "verified", "Breaking Bad"],
      ],
    );

    assert.deepEqual(body.watch, [
      { kind: "stream", service: "Netflix", url: "https://www.themoviedb.org/tv/1396/watch", logoUrl: "https://image.tmdb.org/t/p/w185/n.jpg" },
    ]);
    assert.equal(body.cast[0]?.name, "Bryan Cranston");
    assert.equal(body.cast[0]?.character, "Walter White");

    // The clip's working directory is cleaned up once it has been analysed.
    const leftovers = await fs.readdir(config.tmpDir).catch(() => [] as string[]);
    assert.ok(!leftovers.some((f) => f.startsWith(sessionId)), "the clip's scratch directory must be removed");
  });
});
