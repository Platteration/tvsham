import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Identification } from "@tvsham/shared";
import { calibrationGap, disagreements, formatComparison } from "./compare.js";
import type { ClipLabel, ScoredClip, Verdict } from "./score.js";

const id: Identification = { kind: "movie", title: "Inception", confidence: 0.9, evidence: "t" };

const clip = (file: string, verdict: Verdict, confidence: number): ScoredClip => ({
  label: { file, kind: "movie", title: "Inception" } as ClipLabel,
  identification: { ...id, confidence },
  verdict,
  confidence,
  seconds: 1,
});

describe("comparing two runs", () => {
  it("lists only the clips the runs scored differently", () => {
    const a = [clip("one.mp4", "correct", 0.9), clip("two.mp4", "correct", 0.9), clip("three.mp4", "wrong", 0.5)];
    const b = [clip("one.mp4", "correct", 0.8), clip("two.mp4", "wrong", 0.7), clip("three.mp4", "wrong", 0.4)];
    const diff = disagreements(a, b);
    assert.deepEqual(diff.map((d) => d.file), ["two.mp4"]);
    assert.equal(diff[0]?.a.verdict, "correct");
    assert.equal(diff[0]?.b.verdict, "wrong");
  });

  it("ignores clips missing from the other run", () => {
    assert.deepEqual(disagreements([clip("only-here.mp4", "correct", 0.9)], []), []);
  });

  it("measures the gap between confidence when right and when wrong", () => {
    const confident = [clip("a.mp4", "correct", 0.9), clip("b.mp4", "wrong", 0.3)];
    assert.ok(Math.abs(calibrationGap(confident) - 0.6) < 1e-9);
    // A model equally sure of its right and wrong answers has nothing to threshold on.
    const uncalibrated = [clip("a.mp4", "correct", 0.8), clip("b.mp4", "wrong", 0.8)];
    assert.equal(calibrationGap(uncalibrated), 0);
  });

  it("advises against a cheap first pass when confidence cannot separate right from wrong", () => {
    const a = [clip("a.mp4", "correct", 0.9), clip("b.mp4", "correct", 0.9)];
    const uncalibrated = [clip("a.mp4", "correct", 0.8), clip("b.mp4", "wrong", 0.8)];
    const report = formatComparison(a, uncalibrated, "big", "cheap");
    assert.match(report, /leave FIRST_PASS_MODEL unset/);
    assert.match(report, /cheap is 50\.0% worse than big/);
  });

  it("endorses a cheap first pass when it is clearly less sure when wrong", () => {
    const a = [clip("a.mp4", "correct", 0.9), clip("b.mp4", "correct", 0.9)];
    const calibrated = [clip("a.mp4", "correct", 0.95), clip("b.mp4", "wrong", 0.2)];
    const report = formatComparison(a, calibrated, "big", "cheap");
    assert.match(report, /should escalate the clips it gets wrong/);
  });
});
