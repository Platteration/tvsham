import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TimeoutError, withDeadline } from "./deadline.js";

/** A call that only ever finishes because its signal told it to, like a black-holed fetch. */
function neverAnswers(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("AbortError")));
  });
}

describe("deadlines", () => {
  it("gives up on a server that never answers", async () => {
    const started = Date.now();
    await assert.rejects(withDeadline(40, "Reaching the server", undefined, neverAnswers), (err: unknown) => {
      assert.ok(err instanceof TimeoutError, "a deadline must not look like a cancellation");
      assert.match(String(err), /Reaching the server took longer than/);
      return true;
    });
    assert.ok(Date.now() - started < 2_000);
  });

  it("passes a result straight through and stops the clock", async () => {
    assert.equal(await withDeadline(50, "x", undefined, async () => "answer"), "answer");
    // A timer left running would keep this process alive past the test; node's
    // runner fails the file if it does, which is the assertion.
  });

  it("lets the caller's own cancellation win", async () => {
    const outer = new AbortController();
    const run = withDeadline(5_000, "Sending the clip", outer.signal, neverAnswers);
    outer.abort();
    await assert.rejects(run, (err: unknown) => {
      assert.ok(!(err instanceof TimeoutError), "the user cancelled; that is not a timeout");
      return true;
    });
  });

  it("does not start a call the caller has already cancelled", async () => {
    const outer = AbortSignal.abort();
    let sawAborted = false;
    await withDeadline(50, "x", outer, async (signal) => {
      sawAborted = signal.aborted;
    });
    assert.equal(sawAborted, true);
  });

  it("reports its own expiry, not the error the aborted call threw", async () => {
    await assert.rejects(
      withDeadline(20, "Asking the server for the result", undefined, async (signal) => {
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
        throw new Error("AbortError: The user aborted a request.");
      }),
      TimeoutError,
    );
  });
});
