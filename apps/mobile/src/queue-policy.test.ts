import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isHopeless } from "./queue-policy.js";

describe("queue drop policy", () => {
  it("drops clips the server can never accept", () => {
    for (const status of [400, 413, 415, 422]) assert.equal(isHopeless(status), true, `status ${status}`);
  });

  it("keeps clips rejected for reasons about the caller, not the clip", () => {
    // 429 is the daily cap: the same clip works again tomorrow.
    // 401 means the token is not set up yet. 5xx is the server's problem.
    for (const status of [401, 403, 429, 500, 502, 503]) assert.equal(isHopeless(status), false, `status ${status}`);
  });

  it("keeps clips when there was no status at all (a network failure)", () => {
    assert.equal(isHopeless(undefined), false);
  });
});
