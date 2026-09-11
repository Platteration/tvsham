import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanQueuedClips,
  cleanRecognitionResult,
  cleanSavedItems,
  cleanSessionHandle,
  readSavedItems,
} from "./shapes.js";

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

  it("takes a session only when it comes with the key that authorises it", () => {
    // The id names the session and the key is what every later call has to
    // carry; a reply with one and not the other is a session the app would be
    // answered 404 for four times over before it worked that out.
    const real = { sessionId: "3f1c6f0e-2c5b-4a1d-9d54-9f1f0f4a22b1", sessionKey: "a".repeat(43) };
    assert.deepEqual(cleanSessionHandle(real), real);
    assert.equal(cleanSessionHandle({ sessionId: real.sessionId }), null);
    assert.equal(cleanSessionHandle({ sessionKey: real.sessionKey }), null);
    assert.equal(cleanSessionHandle({ sessionId: real.sessionId, sessionKey: 7 }), null);
    assert.equal(cleanSessionHandle("nope"), null);
    assert.equal(cleanSessionHandle(null), null);
  });

  it("refuses a session whose halves cannot go in a URL and a header", () => {
    // The id is interpolated into every request path and the key is sent as
    // X-Session-Key, so both cross a protocol boundary - which is why the
    // server constrains the charset of the clip key it compares. A value with
    // a newline in it makes fetch throw a TypeError rather than answer, and a
    // thrown fetch is what the app reads as "the network is down": the clip
    // goes to the offline queue and is retried against the same answer for
    // ever.
    const key = "a".repeat(43);
    const id = "3f1c6f0e-2c5b-4a1d-9d54-9f1f0f4a22b1";
    assert.equal(cleanSessionHandle({ sessionId: id, sessionKey: "k\r\nX-Evil: 1" }), null);
    assert.equal(cleanSessionHandle({ sessionId: "s1/../../health", sessionKey: key }), null);
    assert.equal(cleanSessionHandle({ sessionId: "has space", sessionKey: key }), null);
    assert.equal(cleanSessionHandle({ sessionId: id, sessionKey: "short" }), null);
    assert.equal(cleanSessionHandle({ sessionId: "", sessionKey: key }), null);
    assert.equal(cleanSessionHandle({ sessionId: id, sessionKey: `${key} ` }), null);
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

/**
 * The records the app wrote itself. They go through the same coercion, because
 * an older build or one the OS killed mid-write left some of them, but they are
 * not a response: the ceiling that stops one reply filling the device would,
 * applied here, delete what the user chose to keep.
 */
describe("stored records", () => {
  function savedItem(i: number) {
    return {
      id: `s${i}`,
      savedAt: `2026-01-0${(i % 9) + 1}T12:00:00.000Z`,
      source: i % 3 === 0 ? "screen" : "camera",
      identification: { kind: "movie", title: `Film ${i}`, confidence: 0.9, evidence: "poster" },
      links: [
        { provider: "wikipedia", url: `https://en.wikipedia.org/wiki/Film_${i}`, title: `Film ${i}`, confidence: "verified" },
      ],
      watched: i % 2 === 0,
    };
  }

  it("keeps a saved library larger than the response ceiling through a hydrate and a re-write", () => {
    // Nothing caps the library: saving is one tap per identification, and
    // saveResult, saveHistoryItem, removeSaved and setWatched all leave the
    // length alone, so a heavy user's record is longer than any response. If
    // the response ceiling reached this list, hydrate would shed the oldest
    // items and the first save, remove or watch-toggle afterwards would write
    // the shortened list back over the record, with no way back in the app.
    const saved = Array.from({ length: 150 }, (_, i) => savedItem(i));
    const ids = saved.map((i) => i.id);

    // hydrate(): libraryStore.set(readSavedItems(record)).
    const hydrated = readSavedItems(JSON.stringify(saved));
    assert.deepEqual(hydrated.map((i) => i.id), ids, "a hydrate must not shed saved items");

    // persistLibrary(): the next change writes whatever the store now holds
    // back over the record. Read that the way the launch after it would.
    const relaunched = readSavedItems(JSON.stringify(hydrated));
    assert.deepEqual(relaunched.map((i) => i.id), ids, "a re-write must not make a truncation permanent");
    assert.deepEqual(relaunched, hydrated, "every field of every item must survive the round trip");
    assert.deepEqual(relaunched, saved, "and match what was saved in the first place");
  });

  it("still caps the links a stored item carries", () => {
    // Only the list of items lost its ceiling. What is inside an item came from
    // a response, and the result screen maps over it.
    const item = { ...savedItem(0), links: Array.from({ length: 500 }, (_, i) => ({ url: `https://example.com/${i}` })) };
    const [cleaned] = cleanSavedItems([item]);
    assert.equal(cleaned?.links.length, 100);
  });

  it("reads a record that is missing, empty or not JSON as an empty list", () => {
    for (const raw of [null, undefined, "", "{oh no", "null", "\"nope\""]) {
      assert.deepEqual(readSavedItems(raw), [], `${String(raw)} must not abort the hydrate`);
    }
  });
});
