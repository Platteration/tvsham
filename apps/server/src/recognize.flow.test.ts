import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { recognise, recogniseWithEscalation, setClientForTests, type Evidence } from "./recognize.js";

function evidence(): Evidence {
  return {
    source: "camera",
    frames: [{ t: 1, jpeg: Buffer.from([0xff, 0xd8, 0xff]), clip: 0 }],
    transcripts: ["I am the one who knocks."],
  };
}

interface FakeCalls {
  create: Array<{ messages: Array<{ role: string; content: unknown }> }>;
  parse: Array<{ messages: Array<{ content: unknown }> }>;
}

function fakeClient(opts: {
  createResponses: Array<{ stop_reason: string; content: unknown[] }>;
  parsed: unknown | ((call: number) => unknown);
}): { client: Anthropic; calls: FakeCalls } {
  const calls: FakeCalls = { create: [], parse: [] };
  const responses = [...opts.createResponses];
  const client = {
    beta: {
      messages: {
        create: async (params: FakeCalls["create"][number]) => {
          calls.create.push(structuredClone(params));
          return responses.shift();
        },
      },
    },
    messages: {
      parse: async (params: FakeCalls["parse"][number] & { model?: string }) => {
        calls.parse.push(params);
        const out = typeof opts.parsed === "function" ? (opts.parsed as (n: number) => unknown)(calls.parse.length) : opts.parsed;
        return { parsed_output: out };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const parsed = {
  kind: "tv_episode",
  title: "Breaking Bad",
  year: 2008,
  season: 4,
  episodeNumber: 6,
  episodeTitle: "Cornered",
  creator: null,
  creatorHandle: null,
  platform: null,
  wikipediaTitle: "Breaking Bad",
  wikipediaEpisodeTitle: "Cornered (Breaking Bad)",
  youtubeUrl: null,
  videoUrl: null,
  confidence: 0.88,
  evidence: "Quoted line matches the episode.",
  alternatives: [],
};

describe("recognise flow", () => {
  afterEach(() => setClientForTests(null));

  it("resumes a paused server-tool turn, then extracts JSON from the analysis", async () => {
    const { client, calls } = fakeClient({
      createResponses: [
        { stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }] },
        { stop_reason: "end_turn", content: [{ type: "text", text: "KIND: tv_episode\nTITLE: Breaking Bad" }] },
      ],
      parsed,
    });
    setClientForTests(client);

    const id = await recognise(evidence());

    assert.equal(calls.create.length, 2);
    // Second request replays the paused assistant turn so the server resumes.
    assert.equal(calls.create[1]!.messages.length, 2);
    assert.equal(calls.create[1]!.messages[1]!.role, "assistant");
    // Frames and transcript went into the first user message.
    const first = calls.create[0]!.messages[0]!.content as Array<{ type: string; text?: string }>;
    assert.ok(first.some((b) => b.type === "image"));
    assert.ok(first.some((b) => b.text?.includes("I am the one who knocks.")));
    // The extraction call received the analysis text.
    assert.equal(calls.parse.length, 1);
    assert.match(String(calls.parse[0]!.messages[0]!.content), /TITLE: Breaking Bad/);

    assert.equal(id.kind, "tv_episode");
    assert.deepEqual(id.episode, { season: 4, number: 6, title: "Cornered" });
    assert.equal(id.confidence, 0.88);
  });

  it("returns unknown on a refusal without calling the extractor", async () => {
    const { client, calls } = fakeClient({
      createResponses: [{ stop_reason: "refusal", content: [] }],
      parsed,
    });
    setClientForTests(client);
    const id = await recognise(evidence());
    assert.equal(id.kind, "unknown");
    assert.equal(id.confidence, 0);
    assert.equal(calls.parse.length, 0);
  });

  it("returns unknown with no frames and makes no API calls", async () => {
    const { client, calls } = fakeClient({ createResponses: [], parsed });
    setClientForTests(client);
    const id = await recognise({ ...evidence(), frames: [] });
    assert.equal(id.kind, "unknown");
    assert.equal(calls.create.length, 0);
  });
});

describe("cheap first pass", () => {
  const originalFirst = config.firstPassModel;
  const setFirst = (v: string | undefined) => {
    (config as { firstPassModel?: string }).firstPassModel = v;
  };
  afterEach(() => {
    setClientForTests(null);
    setFirst(originalFirst);
  });

  const ok = { stop_reason: "end_turn", content: [{ type: "text", text: "analysis" }] };
  const modelsUsed = (calls: FakeCalls) => calls.create.map((c) => (c as { model?: string }).model);

  it("stops after the cheap model when it is confident", async () => {
    setFirst("claude-sonnet-5");
    const { client, calls } = fakeClient({ createResponses: [ok, ok], parsed: { ...parsed, confidence: 0.9 } });
    setClientForTests(client);
    const id = await recogniseWithEscalation(evidence());
    assert.equal(calls.create.length, 1);
    assert.deepEqual(modelsUsed(calls), ["claude-sonnet-5"]);
    assert.equal(id.confidence, 0.9);
  });

  it("re-reads the same evidence on the main model when the cheap pass is unsure", async () => {
    setFirst("claude-sonnet-5");
    const { client, calls } = fakeClient({
      createResponses: [ok, ok],
      parsed: (n) => ({ ...parsed, confidence: n === 1 ? 0.4 : 0.95 }),
    });
    setClientForTests(client);
    const id = await recogniseWithEscalation(evidence());
    assert.deepEqual(modelsUsed(calls), ["claude-sonnet-5", config.model]);
    assert.equal(id.confidence, 0.95);
  });

  it("keeps the cheap answer when the main model is even less sure", async () => {
    setFirst("claude-sonnet-5");
    const { client } = fakeClient({
      createResponses: [ok, ok],
      parsed: (n) => ({ ...parsed, confidence: n === 1 ? 0.5 : 0.2 }),
    });
    setClientForTests(client);
    assert.equal((await recogniseWithEscalation(evidence())).confidence, 0.5);
  });

  it("makes one call when no cheap model is configured", async () => {
    setFirst(undefined);
    const { client, calls } = fakeClient({ createResponses: [ok], parsed: { ...parsed, confidence: 0.1 } });
    setClientForTests(client);
    await recogniseWithEscalation(evidence());
    assert.deepEqual(modelsUsed(calls), [config.model]);
  });
});
