import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUsageStore } from "./usage.js";

const DAY = 24 * 60 * 60 * 1000;

describe("usage store", () => {
  it("allows everything when the limit is off", () => {
    const u = createUsageStore(0);
    for (let i = 0; i < 100; i++) assert.equal(u.take("a"), true);
    assert.equal(u.remaining("a"), Number.POSITIVE_INFINITY);
  });

  it("stops a caller at the cap and counts callers separately", () => {
    const u = createUsageStore(2);
    assert.equal(u.take("a"), true);
    assert.equal(u.take("a"), true);
    assert.equal(u.take("a"), false);
    assert.equal(u.used("a"), 2);
    assert.equal(u.remaining("a"), 0);
    assert.equal(u.take("b"), true);
  });

  it("resets on the next day", () => {
    const u = createUsageStore(1);
    const t = 1_800_000_000_000;
    assert.equal(u.take("a", t), true);
    assert.equal(u.take("a", t + 1000), false);
    assert.equal(u.take("a", t + DAY), true);
    assert.equal(u.used("a", t + DAY), 1);
  });
});
