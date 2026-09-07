import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Identification } from "@tvsham/shared";
import { actionLabel, kindLabel, providerBadge, subtitleFor } from "./format.js";
import { paletteFor } from "./palette.js";

const base: Identification = { kind: "movie", title: "Inception", confidence: 0.9, evidence: "t" };

describe("kindLabel", () => {
  it("names every kind in plain words", () => {
    const kinds: Array<Identification["kind"]> = [
      "movie", "tv_episode", "tv_show", "youtube", "short_form", "other", "unknown",
    ];
    const labels = kinds.map(kindLabel);
    assert.deepEqual(labels, ["Movie", "TV episode", "TV show", "YouTube", "Short video", "Broadcast", "Unknown"]);
    // No label leaks the internal snake_case name.
    for (const l of labels) assert.ok(!l.includes("_"), l);
  });
});

describe("subtitleFor", () => {
  it("spells out a season and episode", () => {
    assert.equal(
      subtitleFor({ ...base, kind: "tv_episode", title: "Breaking Bad", episode: { season: 5, number: 14, title: "Ozymandias" } }),
      "Season 5, Episode 14 · “Ozymandias”",
    );
  });

  it("handles an episode number with no season", () => {
    assert.equal(subtitleFor({ ...base, kind: "tv_episode", episode: { number: 3 } }), "Episode 3");
  });

  it("shows the year for a film but not alongside episode details", () => {
    assert.equal(subtitleFor({ ...base, year: 2010 }), "2010");
    assert.equal(
      subtitleFor({ ...base, kind: "tv_episode", year: 2013, episode: { season: 1, number: 2 } }),
      "Season 1, Episode 2",
    );
  });

  it("credits the creator of a short video", () => {
    assert.equal(subtitleFor({ ...base, kind: "youtube", creator: "MrBeast" }), "MrBeast");
  });

  it("is empty when there is nothing to add", () => {
    assert.equal(subtitleFor(base), "");
  });
});

describe("actionLabel", () => {
  it("matches the verb to the destination", () => {
    assert.equal(actionLabel({ provider: "wikipedia", url: "u", title: "t", confidence: "verified" }), "Read on Wikipedia");
    assert.equal(actionLabel({ provider: "youtube", url: "u", title: "t", confidence: "verified" }), "Watch now");
    assert.equal(actionLabel({ provider: "tiktok", url: "u", title: "t", confidence: "search" }), "Search for it");
  });
});

describe("providerBadge", () => {
  it("labels every provider and falls back for the generic one", () => {
    const p = paletteFor("dark", "midnight");
    assert.equal(providerBadge(p, "wikipedia").label, "Wikipedia");
    assert.equal(providerBadge(p, "youtube").color, p.youtube);
    assert.equal(providerBadge(p, "tiktok").label, "TikTok");
    assert.equal(providerBadge(p, "instagram").color, p.instagram);
    assert.equal(providerBadge(p, "web").color, p.surfaceAlt);
  });
});
