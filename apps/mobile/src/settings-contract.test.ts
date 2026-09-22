import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ACCENTS } from "./palette.js";
import { APPEARANCES, DEFAULT_SETTINGS, KEYS, PREFERENCE_FIELDS, REDUCE_MOTION } from "./settings.js";

/**
 * The settings contract, pinned as literals. Each of these is something a
 * refactor could change without any other test noticing: a renamed storage
 * key orphans every user's record on their next launch, a dropped row or enum
 * member is a preference the app quietly forgets, and a haptic or a
 * confirmation that bypasses the shared module ignores the setting that
 * governs it.
 */

// .pathname rather than fileURLToPath: the DOM lib's URL type and Node's
// disagree under this tsconfig, and the path has nothing to decode.
const root = new URL("..", import.meta.url).pathname;

/** Every source file a screen or a module lives in; tests are not screens. */
function sources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const dir of ["app", "src"]) {
    for (const name of readdirSync(join(root, dir))) {
      if (!/\.tsx?$/.test(name) || /\.test\.ts$/.test(name)) continue;
      const file = `${dir}/${name}`;
      out.push({ file, text: readFileSync(join(root, file), "utf8") });
    }
  }
  assert.ok(out.length > 10, "found the app's sources");
  return out;
}

describe("the settings contract", () => {
  it("names every record the app stores, under the keys it has always used", () => {
    assert.deepEqual(KEYS, {
      settings: "tvsham.settings.v1",
      library: "tvsham.library.v1",
      history: "tvsham.history.v1",
      device: "tvsham.device.v1",
      queue: "tvsham.queue.v1",
      token: "tvsham.token.v1",
    });
  });

  it("writes a storage key nowhere but the table", () => {
    // A key string in a screen or the store is one the table does not govern.
    for (const { file, text } of sources()) {
      if (file === "src/settings.ts") continue;
      assert.equal(text.match(/tvsham\.[a-z]+\.v\d+/g), null, `${file} spells out a storage key`);
    }
  });

  it("has exactly these rows, and Reset touches exactly these", () => {
    assert.deepEqual(Object.keys(DEFAULT_SETTINGS), [
      "serverUrl",
      "token",
      "appearance",
      "accent",
      "unlockedAccents",
      "haptics",
      "reduceMotion",
    ]);
    assert.deepEqual([...PREFERENCE_FIELDS], ["appearance", "accent", "haptics", "reduceMotion"]);
  });

  it("has exactly these enum values", () => {
    assert.deepEqual(Object.keys(APPEARANCES), ["system", "light", "dark"]);
    assert.deepEqual(Object.keys(REDUCE_MOTION), ["system", "on", "off"]);
    assert.deepEqual(Object.keys(ACCENTS), ["midnight", "sunset", "forest", "mono"]);
  });

  it("fires every haptic through feedback.ts, where the Vibration setting is", () => {
    for (const { file, text } of sources()) {
      if (file === "src/feedback.ts") continue;
      assert.doesNotMatch(text, /from "expo-haptics"/, `${file} calls expo-haptics directly, past the setting`);
    }
  });

  it("asks every confirmation through confirm.ts, where the web fallback is", () => {
    // react-native-web's Alert.alert is an empty function: a bare Alert confirm
    // is a button that does nothing on that platform.
    for (const { file, text } of sources()) {
      if (file === "src/confirm.ts") continue;
      assert.doesNotMatch(text, /\bAlert\.alert\(/, `${file} confirms with a bare Alert.alert`);
    }
  });

  it("opens the source link through the same gate as every other link", () => {
    const settings = readFileSync(join(root, "app/settings.tsx"), "utf8");
    assert.match(settings, /const SOURCE_URL = "https:\/\/github\.com\/Platteration\/tvsham"/);
    assert.match(settings, /isSafeWebUrl\(SOURCE_URL\)/, "the source link passes isSafeWebUrl before it is opened");
    assert.match(settings, /Constants\.expoConfig\?\.version \?\? "0\.0\.0"/, "the version comes from expo-constants");
  });
});
