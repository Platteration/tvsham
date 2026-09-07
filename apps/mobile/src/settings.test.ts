import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, sanitise, type Settings } from "./settings.js";

/** Settings as they might come back from an older install: anything goes. */
const stored = (patch: Record<string, unknown>) => ({ ...DEFAULT_SETTINGS, ...patch }) as Settings;

describe("settings validation", () => {
  it("passes sound settings through untouched", () => {
    const s = stored({ serverUrl: "http://host:8787", token: "t", appearance: "light", accent: "forest" });
    assert.deepEqual(sanitise(s), s);
  });

  it("falls back to a known accent", () => {
    assert.equal(sanitise(stored({ accent: "chartreuse" })).accent, "midnight");
    assert.equal(sanitise(stored({ accent: undefined })).accent, "midnight");
    assert.equal(sanitise(stored({ accent: 7 })).accent, "midnight");
  });

  it("falls back to following the system appearance", () => {
    assert.equal(sanitise(stored({ appearance: "sepia" })).appearance, "system");
    assert.equal(sanitise(stored({ appearance: null })).appearance, "system");
    assert.equal(sanitise(stored({ appearance: "dark" })).appearance, "dark");
  });

  it("keeps only accent packs it recognises, and never leaves the user with none", () => {
    assert.deepEqual(sanitise(stored({ unlockedAccents: ["forest", "chartreuse"] })).unlockedAccents, ["forest"]);
    assert.deepEqual(sanitise(stored({ unlockedAccents: [] })).unlockedAccents, DEFAULT_SETTINGS.unlockedAccents);
    assert.deepEqual(sanitise(stored({ unlockedAccents: "all" })).unlockedAccents, DEFAULT_SETTINGS.unlockedAccents);
  });

  it("coerces non-string server details to empty rather than crashing later", () => {
    const s = sanitise(stored({ serverUrl: 42, token: null }));
    assert.equal(s.serverUrl, "");
    assert.equal(s.token, "");
  });

  it("survives a completely empty object", () => {
    assert.deepEqual(sanitise({} as Settings), DEFAULT_SETTINGS);
  });
});
