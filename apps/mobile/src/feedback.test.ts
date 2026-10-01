import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createFeedback, type Feedback, type HapticsDriver } from "./feedback-gate.js";

// .pathname rather than fileURLToPath: the DOM lib's URL type and Node's
// disagree under this tsconfig, and the path has nothing to decode.
const root = new URL("..", import.meta.url).pathname;

/** A phone that only takes notes; `outcome` is what each effect resolves to. */
function fakePhone(outcome: () => Promise<void> = () => Promise.resolve()) {
  const calls: string[] = [];
  const driver: HapticsDriver = {
    impact: (style) => {
      calls.push(`impact:${style}`);
      return outcome();
    },
    notification: (kind) => {
      calls.push(`notification:${kind}`);
      return outcome();
    },
  };
  return { calls, driver };
}

/** Every moment, with the effect it asks the phone for. */
const MOMENTS: Array<[name: string, effect: string, fire: (f: Feedback) => void]> = [
  ["captureStarted", "impact:medium", (f) => f.captureStarted()],
  ["recordingPicked", "impact:light", (f) => f.recordingPicked()],
  ["queued", "notification:warning", (f) => f.queued()],
  ["identified(true)", "notification:success", (f) => f.identified(true)],
  ["identified(false)", "notification:warning", (f) => f.identified(false)],
  ["savedForLater", "notification:success", (f) => f.savedForLater()],
];

/**
 * The Vibration setting is a switch whose whole effect is this gate. The
 * mobile suite stayed green with the gate deleted, so this is what pins it.
 */
describe("the Vibration gate", () => {
  it("is on until the store says otherwise, and every moment reaches the phone", () => {
    for (const [name, effect, fire] of MOMENTS) {
      const { calls, driver } = fakePhone();
      fire(createFeedback(driver));
      assert.deepEqual(calls, [effect], name);
    }
  });

  it("lets nothing through with Vibration off, and everything again once it is back on", () => {
    for (const [name, effect, fire] of MOMENTS) {
      const { calls, driver } = fakePhone();
      const feedback = createFeedback(driver);
      feedback.setHapticsEnabled(false);
      fire(feedback);
      assert.deepEqual(calls, [], `${name} reached the phone with Vibration off`);
      feedback.setHapticsEnabled(true);
      fire(feedback);
      assert.deepEqual(calls, [effect], `${name} did not reach the phone once Vibration was back on`);
    }
  });

  it("swallows a phone that rejects", async () => {
    // A phone without a haptic engine rejects; that is nothing to surface,
    // and an unhandled rejection here would fail this process.
    const { driver } = fakePhone(() => Promise.reject(new Error("no haptic engine")));
    const feedback = createFeedback(driver);
    assert.doesNotThrow(() => feedback.captureStarted());
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("is the only gate: feedback.ts binds the moments to expo-haptics and decides nothing", () => {
    // The device binding is thin on purpose. A moment or a condition added
    // there rather than in the gate would fire past the setting, untested.
    const text = readFileSync(join(root, "src/feedback.ts"), "utf8");
    assert.match(text, /= createFeedback\(\{/);
    assert.doesNotMatch(text, /\b(let|if|enabled)\b/, "feedback.ts keeps no state and takes no decision");
    assert.equal((text.match(/Haptics\.\w+Async\(/g) ?? []).length, 2, "one call per driver method, and no more");
  });
});
