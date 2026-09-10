import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanQueuedClips, cleanRecognitionResult, cleanSavedItems } from "./shapes.js";

/**
 * The payloads here are what an on-path attacker on a cleartext hop, or a
 * half-written record on disk, actually looks like: the right field names with
 * the wrong types. Every one of them used to reach a `.map` or a `.find` on the
 * result screen.
 */
describe("untrusted shapes", () => {
  it("makes a renderable result out of a hostile response", () => {
    const result = cleanRecognitionResult(
      JSON.parse(`{
        "sessionId": 7,
        "status": "identified-ish",
        "secondsAnalysed": "eight",
        "links": "not-an-array",
        "watch": null,
        "cast": { "0": "nope" },
        "wantsMore": "yes",
        "analysing": 1,
        "message": null,
        "identification": { "kind": "documentary", "title": 42, "confidence": 9, "evidence": null }
      }`),
      "fallback-session",
    );

    assert.equal(result.sessionId, "fallback-session");
    assert.equal(result.status, "failed", "an unreadable answer must not claim a match");
    assert.equal(result.secondsAnalysed, 0);
    assert.deepEqual(result.links, []);
    assert.deepEqual(result.watch, []);
    assert.deepEqual(result.cast, []);
    assert.equal(result.wantsMore, false, "only a real true ends the loop or continues it");
    assert.equal(result.analysing, false);
    assert.equal(result.message, "");
    assert.equal(result.identification?.kind, "unknown");
    assert.equal(result.identification?.title, "Unknown");
    assert.equal(result.identification?.confidence, 1);
    assert.equal(result.identification?.evidence, "");
  });

  it("keeps what is genuinely there", () => {
    const result = cleanRecognitionResult({
      sessionId: "s1",
      status: "identified",
      secondsAnalysed: 8.4,
      links: [
        { provider: "wikipedia", url: "https://en.wikipedia.org/wiki/X", title: "X", confidence: "verified" },
        { provider: "web", title: "no url here", confidence: "search" },
        { url: "https://example.com/y", title: 5, provider: "carrier-pigeon", confidence: "trust me" },
      ],
      watch: [
        { kind: "rent", service: "Prime Video", url: "https://example.com/w" },
        { kind: "stream", url: "https://example.com/no-service" },
      ],
      cast: [{ name: "Bryan Cranston", character: "Walter White" }, { character: "nobody" }],
      wantsMore: true,
      analysing: true,
      message: "Found it.",
      identification: {
        kind: "tv_episode",
        title: "Breaking Bad",
        year: 2013,
        confidence: 0.93,
        evidence: "Dialogue matched.",
        episode: { season: 5, number: 14, title: "Ozymandias" },
        alternatives: [{ title: "Better Call Saul", kind: "tv_show", year: 2015 }, { kind: "movie" }],
      },
    });

    assert.equal(result.secondsAnalysed, 8);
    assert.deepEqual(result.links.map((l) => l.url), ["https://en.wikipedia.org/wiki/X", "https://example.com/y"]);
    // A link with an unknown provider is still a link; it just loses the label.
    assert.equal(result.links[1]?.provider, "web");
    assert.equal(result.links[1]?.title, "https://example.com/y", "a titleless link falls back to its url");
    assert.deepEqual(result.watch.map((w) => w.service), ["Prime Video"]);
    assert.deepEqual(result.cast.map((c) => c.name), ["Bryan Cranston"]);
    assert.equal(result.status, "identified");
    assert.equal(result.wantsMore, true);
    assert.deepEqual(result.identification?.episode, { season: 5, number: 14, title: "Ozymandias" });
    assert.deepEqual(result.identification?.alternatives, [
      { title: "Better Call Saul", kind: "tv_show", year: 2015 },
    ]);
  });

  it("survives a response that is not an object at all", () => {
    for (const raw of [null, "", 12, [1, 2, 3], undefined]) {
      const result = cleanRecognitionResult(raw);
      assert.deepEqual(result.links, []);
      assert.equal(result.identification, undefined);
      assert.equal(result.status, "failed");
    }
  });

  it("drops saved items that could not be drawn or removed", () => {
    const items = cleanSavedItems([
      { id: "a", savedAt: "2026-01-01", source: "screen", identification: { kind: "movie", title: "Heat" }, links: [], watched: true },
      { id: "b", links: [], watched: false },
      { savedAt: "no id", identification: { kind: "movie", title: "Nameless" } },
      { id: "c", identification: { kind: "movie", title: "Links gone" }, links: "gone", watched: "yes" },
      "not an item",
    ]);

    assert.deepEqual(items.map((i) => i.id), ["a", "c"]);
    assert.equal(items[0]?.source, "screen");
    assert.equal(items[0]?.watched, true);
    assert.deepEqual(items[1]?.links, [], "a broken links field must not reach item.links.find");
    assert.equal(items[1]?.watched, false);
    assert.equal(items[1]?.source, "camera");
  });

  it("drops queued clips with nothing to upload", () => {
    const clips = cleanQueuedClips([
      { id: "1", uri: "file:///a.mp4", source: "screen", queuedAt: "t", reason: "offline", hint: "on Netflix" },
      { id: "2", source: "camera", queuedAt: "t", reason: "offline" },
      { uri: "file:///c.mp4" },
      { id: "4", uri: "file:///d.mp4", source: "telepathy", queuedAt: 0, reason: null },
    ]);

    assert.deepEqual(clips.map((c) => c.id), ["1", "4"]);
    assert.equal(clips[0]?.hint, "on Netflix");
    assert.equal(clips[1]?.source, "camera", "an unknown source is the ordinary one, not a crash");
    assert.equal(clips[1]?.queuedAt, "");
    assert.equal(clips[1]?.hint, undefined);
  });

  it("does not let one response fill the device", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ url: `https://example.com/${i}`, title: `#${i}` }));
    const result = cleanRecognitionResult({ links: many, message: "x".repeat(10_000) });
    assert.equal(result.links.length, 100);
    assert.equal(result.message.length, 2000);
  });
});
