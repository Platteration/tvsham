import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { recognise, setClientForTests, type Evidence } from "./recognize.js";

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
  parsed: unknown;
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
      parse: async (params: FakeCalls["parse"][number]) => {
        calls.parse.push(params);
        return { parsed_output: opts.parsed };
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
