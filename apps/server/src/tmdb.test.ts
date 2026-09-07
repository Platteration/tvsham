import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { config } from "./config.js";
import { setFetchForTests } from "./http.js";
import { enrich, findId, tmdbType, topCast, watchOptions } from "./tmdb.js";

const providers = {
  results: {
    US: {
      link: "https://www.themoviedb.org/movie/27205/watch?locale=US",
      flatrate: [{ provider_name: "Netflix", logo_path: "/net.jpg" }],
      rent: [{ provider_name: "Apple TV", logo_path: null }, { provider_name: "Netflix", logo_path: "/net.jpg" }],
      buy: [{ provider_name: "Prime Video", logo_path: "/prime.jpg" }],
    },
    GB: { flatrate: [{ provider_name: "Sky", logo_path: "/sky.jpg" }] },
  },
};

function fakeFetch(url: string | URL): Promise<Response> {
  const u = String(url);
  if (u.includes("/search/movie")) return Promise.resolve(Response.json({ results: [{ id: 27205, title: "Inception" }] }));
  if (u.includes("/search/tv")) return Promise.resolve(Response.json({ results: [] }));
  if (u.includes("/watch/providers")) return Promise.resolve(Response.json(providers));
  if (u.includes("/credits")) {
    return Promise.resolve(
      Response.json({
        cast: Array.from({ length: 20 }, (_, i) => ({
          id: i,
          name: `Actor ${i}`,
          character: `Role ${i}`,
          profile_path: i === 0 ? "/a.jpg" : null,
        })),
      }),
    );
  }
  return Promise.resolve(new Response("", { status: 404 }));
}

const movie = { kind: "movie" as const, title: "Inception", year: 2010, confidence: 0.9, evidence: "t" };

describe("tmdb", () => {
  const original = config.tmdbApiKey;
  beforeEach(() => {
    setFetchForTests(fakeFetch as typeof fetch);
    (config as { tmdbApiKey?: string }).tmdbApiKey = "test-key";
  });
  afterEach(() => {
    setFetchForTests(null);
    (config as { tmdbApiKey?: string }).tmdbApiKey = original;
  });

  it("maps kinds to TMDB endpoints", () => {
    assert.equal(tmdbType(movie), "movie");
    assert.equal(tmdbType({ ...movie, kind: "tv_episode" }), "tv");
    assert.equal(tmdbType({ ...movie, kind: "youtube" }), null);
  });

  it("finds an id for a film and gives up on a short video", async () => {
    assert.deepEqual(await findId(movie), { type: "movie", id: 27205 });
    assert.equal(await findId({ ...movie, kind: "short_form" }), null);
    assert.equal(await findId({ ...movie, kind: "tv_show" }), null); // no tv results in the fake
  });

  it("lists each service once, streaming first", async () => {
    const options = await watchOptions({ type: "movie", id: 27205 }, "us");
    assert.deepEqual(
      options.map((o) => [o.kind, o.service]),
      [["stream", "Netflix"], ["rent", "Apple TV"], ["buy", "Prime Video"]],
    );
    assert.equal(options[0]?.logoUrl, "https://image.tmdb.org/t/p/w185/net.jpg");
    assert.match(options[0]!.url, /themoviedb\.org/);
  });

  it("returns nothing for a region with no link", async () => {
    assert.deepEqual(await watchOptions({ type: "movie", id: 27205 }, "GB"), []);
    assert.deepEqual(await watchOptions({ type: "movie", id: 27205 }, "DE"), []);
  });

  it("caps the cast list", async () => {
    const cast = await topCast({ type: "movie", id: 27205 });
    assert.equal(cast.length, 8);
    assert.equal(cast[0]?.name, "Actor 0");
    assert.equal(cast[0]?.imageUrl, "https://image.tmdb.org/t/p/w185/a.jpg");
    assert.equal(cast[1]?.imageUrl, undefined);
    assert.match(cast[0]!.url!, /themoviedb\.org\/person\/0/);
  });

  it("is inert without an API key", async () => {
    (config as { tmdbApiKey?: string }).tmdbApiKey = undefined;
    assert.deepEqual(await enrich(movie, "US"), { watch: [], cast: [] });
    assert.equal(await findId(movie), null);
  });

  it("survives a failing TMDB", async () => {
    setFetchForTests((() => Promise.reject(new Error("down"))) as unknown as typeof fetch);
    assert.deepEqual(await enrich(movie, "US"), { watch: [], cast: [] });
  });
});
