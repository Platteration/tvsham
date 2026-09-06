import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Limiter } from "./limiter.js";

describe("Limiter", () => {
  it("never runs more than the limit at once and preserves order", async () => {
    const l = new Limiter(2);
    let peak = 0;
    const order: number[] = [];
    const gates: Array<() => void> = [];
    const task = (i: number) =>
      l.run(async () => {
        peak = Math.max(peak, l.running);
        order.push(i);
        await new Promise<void>((r) => gates.push(r));
        return i;
      });
    const all = Promise.all([task(1), task(2), task(3), task(4)]);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(l.running, 2);
    assert.equal(l.pending, 2);
    gates.shift()!();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(l.running, 2);
    assert.equal(l.pending, 1);
    while (gates.length) gates.shift()!();
    await new Promise((r) => setTimeout(r, 5));
    while (gates.length) gates.shift()!();
    assert.deepEqual(await all, [1, 2, 3, 4]);
    assert.deepEqual(order, [1, 2, 3, 4]);
    assert.equal(peak, 2);
    assert.equal(l.running, 0);
  });

  it("releases the slot when a task throws", async () => {
    const l = new Limiter(1);
    await assert.rejects(l.run(async () => { throw new Error("boom"); }));
    assert.equal(await l.run(async () => "ok"), "ok");
  });
});
