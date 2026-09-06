import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setFetchForTests } from "./http.js";
import { resolveLinks, youtubeId, youtubeLinkFromUrl, wikipediaLink } from "./resolve.js";

const pages: Record<string, unknown> = {
  "Ozymandias_(Breaking_Bad)": {
    title: "Ozymandias (Breaking Bad)",
    extract: "Ozymandias is the fourteenth episode of the fifth season.",
    thumbnail: { source: "https://upload.wikimedia.org/oz.jpg" },
    content_urls: { mobile: { page: "https://en.m.wikipedia.org/wiki/Ozymandias_(Breaking_Bad)" } },
  },
  Breaking_Bad: {
    title: "Breaking Bad",
    extract: "Breaking Bad is an American crime drama.",
    content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Breaking_Bad" } },
  },
  "Inception_(2010_film)": {
    title: "Inception",
    extract: "Inception is a 2010 science fiction film.",
    content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Inception" } },
  },
  Mercury: { title: "Mercury", type: "disambiguation", content_urls: { desktop: { page: "x" } } },
};

function fakeFetch(url: string | URL | Request): Promise<Response> {
  const u = String(url);
  const summary = /page\/summary\/([^?]+)/.exec(u);
  if (summary) {
    const key = decodeURIComponent(summary[1]!);
    const body = pages[key];
    return Promise.resolve(body ? Response.json(body) : new Response("nope", { status: 404 }));
  }
  if (u.includes("/w/rest.php/v1/search/title")) {
    const q = new URL(u).searchParams.get("q") ?? "";
    const hits = q.toLowerCase().includes("inception") ? [{ title: "Inception (2010 film)" }] : [];
    return Promise.resolve(Response.json({ pages: hits }));
  }
  if (u.startsWith("https://www.youtube.com/oembed")) {
    const target = new URL(u).searchParams.get("url") ?? "";
    if (target.includes("dQw4w9WgXcQ")) {
      return Promise.resolve(
        Response.json({ title: "Never Gonna Give You Up", author_name: "Rick Astley", thumbnail_url: "https://i.ytimg.com/x.jpg" }),
      );
    }
    return Promise.resolve(new Response("", { status: 404 }));
  }
  return Promise.resolve(new Response("", { status: 500 }));
}

describe("youtubeId", () => {
  it("parses watch, shorts, and youtu.be URLs", () => {
    assert.equal(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1s"), "dQw4w9WgXcQ");
    assert.equal(youtubeId("https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
    assert.equal(youtubeId("https://youtube.com/shorts/abcDEF12345"), "abcDEF12345");
    assert.equal(youtubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
    assert.equal(youtubeId("https://example.com/watch?v=dQw4w9WgXcQ"), null);
  });
});

describe("resolvers", () => {
  beforeEach(() => setFetchForTests(fakeFetch as typeof fetch));
  afterEach(() => setFetchForTests(null));

  it("verifies a wikipedia page and skips disambiguation pages", async () => {
    const oz = await wikipediaLink("Ozymandias (Breaking Bad)");
    assert.equal(oz?.confidence, "verified");
    assert.equal(oz?.url, "https://en.m.wikipedia.org/wiki/Ozymandias_(Breaking_Bad)");
    assert.equal(oz?.imageUrl, "https://upload.wikimedia.org/oz.jpg");
    assert.equal(await wikipediaLink("Mercury"), null);
  });

  it("falls back to title search", async () => {
    const inc = await wikipediaLink("Inception movie");
    assert.equal(inc?.title, "Inception");
  });

  it("verifies YouTube via oEmbed", async () => {
    const v = await youtubeLinkFromUrl("https://youtu.be/dQw4w9WgXcQ");
    assert.equal(v?.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.equal(v?.title, "Never Gonna Give You Up");
    assert.equal(v?.description, "Rick Astley");
    assert.equal(await youtubeLinkFromUrl("https://youtu.be/00000000000"), null);
  });

  it("gives an episode article then the show article for a tv_episode", async () => {
    const links = await resolveLinks({
      kind: "tv_episode",
      title: "Breaking Bad",
      episode: { season: 5, number: 14, title: "Ozymandias" },
      confidence: 0.9,
      evidence: "t",
      wikipediaTitle: "Breaking Bad",
      wikipediaEpisodeTitle: "Ozymandias (Breaking Bad)",
    });
    assert.deepEqual(
      links.map((l) => l.title),
      ["Ozymandias (Breaking Bad)", "Breaking Bad"],
    );
  });

  it("returns a verified youtube link for youtube content, else a search fallback", async () => {
    const good = await resolveLinks({
      kind: "youtube",
      title: "Never Gonna Give You Up",
      creator: "Rick Astley",
      confidence: 0.8,
      evidence: "t",
      youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    assert.equal(good[0]?.confidence, "verified");
    const fallback = await resolveLinks({
      kind: "short_form",
      title: "cat knocks over vase",
      confidence: 0.5,
      evidence: "t",
    });
    assert.equal(fallback[0]?.confidence, "search");
    assert.match(fallback[0]!.url, /results\?search_query=/);
  });

  it("returns nothing for unknown", async () => {
    assert.deepEqual(await resolveLinks({ kind: "unknown", title: "?", confidence: 0, evidence: "" }), []);
  });
});
