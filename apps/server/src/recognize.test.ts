import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IdentificationSchema, toIdentification } from "./recognize.js";

const base = {
  kind: "tv_episode" as const,
  title: "Breaking Bad",
  year: 2008,
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
  confidence: 0.92,
  evidence: "Walt on the phone; subtitle text matched.",
  alternatives: [],
};

describe("toIdentification", () => {
  it("maps a full episode result", () => {
    const id = toIdentification(IdentificationSchema.parse(base));
    assert.equal(id.kind, "tv_episode");
    assert.deepEqual(id.episode, { season: 5, number: 14, title: "Ozymandias" });
    assert.equal(id.wikipediaEpisodeTitle, "Ozymandias (Breaking Bad)");
    assert.equal(id.year, 2008);
    assert.equal(id.creator, undefined);
    assert.equal(id.alternatives, undefined);
  });

  it("drops nulls, clamps confidence, and rejects non-YouTube urls", () => {
    const id = toIdentification({
      ...base,
      kind: "youtube",
      year: null,
      season: null,
      episodeNumber: null,
      episodeTitle: null,
      creator: "MrBeast",
      creatorHandle: "@MrBeast",
      platform: "youtube",
      youtubeUrl: "https://vimeo.com/123",
      confidence: 1.4,
      alternatives: [{ title: "Other", kind: "movie", year: null }],
    });
    assert.equal(id.episode, undefined);
    assert.equal(id.year, undefined);
    assert.equal(id.creator, "MrBeast");
    assert.equal(id.creatorHandle, "MrBeast");
    assert.equal(id.platform, "youtube");
    assert.equal(id.youtubeUrl, undefined);
    assert.equal(id.confidence, 1);
    assert.deepEqual(id.alternatives, [{ title: "Other", kind: "movie" }]);
  });

  it("keeps youtube urls and falls back to Unknown for an empty title", () => {
    const id = toIdentification({ ...base, title: "", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ", confidence: -1 });
    assert.equal(id.title, "Unknown");
    assert.equal(id.youtubeUrl, "https://youtu.be/dQw4w9WgXcQ");
    assert.equal(id.confidence, 0);
  });
});
