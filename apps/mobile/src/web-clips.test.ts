import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipFileFor, clipFileName, holdClipFile, releaseClipFile } from "./web-clips.js";

describe("videos picked in a browser", () => {
  it("are held for their upload by the address they were picked as, and let go with it", () => {
    const revoked: string[] = [];
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url: string) => void revoked.push(url);
    try {
      const file = new File([new Uint8Array(2048)], "living-room.mov", { type: "video/quicktime" });
      holdClipFile("blob:site/one", file);
      assert.equal(clipFileFor("blob:site/one"), file);
      assert.equal(clipFileFor("blob:site/two"), undefined);
      releaseClipFile("blob:site/one");
      assert.equal(clipFileFor("blob:site/one"), undefined, "nothing uploads it again");
      assert.deepEqual(revoked, ["blob:site/one"], "and the address no longer names it");
      // Releasing what is not held revokes nothing: a phone's file:// path is not ours to revoke.
      releaseClipFile("file:///data/clip.mp4");
      assert.deepEqual(revoked, ["blob:site/one"]);
    } finally {
      URL.revokeObjectURL = revoke;
    }
  });

  it("are named by their own file name, which the server takes the extension from", () => {
    assert.equal(clipFileName(new File(["x"], "screen.webm"), "clip.mp4"), "screen.webm");
    assert.equal(clipFileName(new Blob(["x"]), "clip.mp4"), "clip.mp4");
    assert.equal(clipFileName(new File(["x"], ""), "clip.mp4"), "clip.mp4");
  });
});
