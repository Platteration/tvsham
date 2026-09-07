import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Identification } from "@tvsham/shared";
import { formatReport, normaliseTitle, score, summarise, titlesMatch, type ClipLabel, type ScoredClip } from "./score.js";

const label: ClipLabel = { file: "bb.mp4", kind: "tv_episode", title: "Breaking Bad", season: 5, episode: 14 };

const said = (patch: Partial<Identification>): Identification => ({
  kind: "tv_episode",
  title: "Breaking Bad",
  confidence: 0.9,
  evidence: "t",
  episode: { season: 5, number: 14 },
  ...patch,
});

describe("title matching", () => {
  it("ignores case, articles, punctuation and parenthetical years", () => {
    assert.equal(normaliseTitle("The Office (US)"), "office");
    assert.equal(normaliseTitle("Inception (2010 film)"), "inception");
    assert.ok(titlesMatch("The Office", "office"));
    assert.ok(titlesMatch("Inception", "Inception (2010)"));
    assert.ok(titlesMatch("WALL·E", "Wall E"));
  });

  it("accepts a longer answer that contains the expected title", () => {
    assert.ok(titlesMatch("Breaking Bad", "Breaking Bad: Ozymandias"));
  });

  it("does not let short titles match by accident", () => {
    assert.equal(titlesMatch("Up", "Superbad"), false);
    assert.equal(titlesMatch("Heat", "Heathers"), false);
    assert.equal(titlesMatch("Fargo", "Fargone"), false);
    assert.equal(titlesMatch("Breaking Bad", "Better Call Saul"), false);
    assert.equal(titlesMatch("", "Breaking Bad"), false);
  });
});

describe("scoring", () => {
  it("marks a full match correct", () => {
    assert.equal(score(label, said({}), 0.35), "correct");
  });

  it("separates a right title with the wrong episode", () => {
    assert.equal(score(label, said({ episode: { season: 5, number: 13 } }), 0.35), "title_only");
    assert.equal(score(label, said({ episode: undefined }), 0.35), "title_only");
  });

  it("counts a low-confidence or unknown answer as an abstention, not an error", () => {
    assert.equal(score(label, said({ confidence: 0.2 }), 0.35), "abstained");
    assert.equal(score(label, said({ kind: "unknown" }), 0.35), "abstained");
  });

  it("marks a different show wrong", () => {
    assert.equal(score(label, said({ title: "Better Call Saul" }), 0.35), "wrong");
  });

  it("treats show and episode, and the two short-video kinds, as the same family", () => {
    // The show kind is accepted, but a label asking for an episode still wants one.
    assert.equal(score(label, said({ kind: "tv_show" }), 0.35), "correct");
    assert.equal(score(label, said({ kind: "tv_show", episode: undefined }), 0.35), "title_only");
    const shortLabel: ClipLabel = { file: "s.mp4", kind: "short_form", title: "Cat video" };
    assert.equal(score(shortLabel, said({ kind: "youtube", title: "Cat video", episode: undefined }), 0.35), "correct");
    assert.equal(score(shortLabel, said({ kind: "movie", title: "Cat video", episode: undefined }), 0.35), "wrong");
  });

  it("does not ask for an episode the label did not specify", () => {
    const showLabel: ClipLabel = { file: "bb.mp4", kind: "tv_show", title: "Breaking Bad" };
    assert.equal(score(showLabel, said({ kind: "tv_show", episode: { season: 2, number: 1 } }), 0.35), "correct");
  });
});

describe("summary", () => {
  const clip = (verdict: ScoredClip["verdict"], confidence: number, seconds = 1): ScoredClip => ({
    label,
    identification: said({ confidence }),
    verdict,
    confidence,
    seconds,
  });

  it("separates accuracy from precision when it answers", () => {
    const s = summarise([clip("correct", 0.9), clip("wrong", 0.8), clip("abstained", 0.1), clip("abstained", 0.2)]);
    assert.equal(s.total, 4);
    assert.equal(s.accuracy, 0.25);
    assert.equal(s.precision, 0.5);
  });

  it("reports confidence when right against when wrong, the calibration signal", () => {
    const s = summarise([clip("correct", 0.9), clip("correct", 0.7), clip("wrong", 0.6), clip("title_only", 0.4)]);
    assert.equal(s.meanConfidenceCorrect, 0.8);
    assert.equal(s.meanConfidenceWrong, 0.5);
  });

  it("takes the median time, so one slow clip does not dominate", () => {
    const s = summarise([clip("correct", 0.9, 2), clip("correct", 0.9, 4), clip("correct", 0.9, 60)]);
    assert.equal(s.medianSeconds, 4);
  });

  it("handles an empty run without dividing by zero", () => {
    const s = summarise([]);
    assert.equal(s.accuracy, 0);
    assert.equal(s.precision, 0);
    assert.equal(s.medianSeconds, 0);
  });

  it("writes a report naming the model and every clip", () => {
    const report = formatReport([clip("correct", 0.9), clip("wrong", 0.8)], "claude-opus-5");
    assert.match(report, /claude-opus-5: 1\/2 correct \(50\.0%\)/);
    assert.match(report, /✓ bb\.mp4/);
    assert.match(report, /✗ bb\.mp4/);
    assert.match(report, /mean confidence/);
  });
});
