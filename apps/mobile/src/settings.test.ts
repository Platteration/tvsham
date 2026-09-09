import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SETTINGS,
  canSendTokenTo,
  cleanServerUrl,
  isPrivateHost,
  sanitise,
  serverUrlWarning,
  type Settings,
} from "./settings.js";

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

  it("keeps only server URLs that are actually web addresses", () => {
    // Everything the app records goes to this address and everything it renders
    // comes back from it, so a stored value that is not http(s) is dropped
    // rather than handed to fetch.
    assert.equal(sanitise(stored({ serverUrl: "https://tv.example.com" })).serverUrl, "https://tv.example.com");
    assert.equal(sanitise(stored({ serverUrl: "  http://192.168.1.20:8787/  " })).serverUrl, "http://192.168.1.20:8787");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "tvsham://x", "192.168.1.20:8787", "not a url", "http://"]) {
      assert.equal(sanitise(stored({ serverUrl: bad })).serverUrl, "", `${bad} must not be kept`);
    }
  });

  it("survives a completely empty object", () => {
    assert.deepEqual(sanitise({} as Settings), DEFAULT_SETTINGS);
  });
});

describe("server address trust", () => {
  it("recognises addresses that cannot leave the local network", () => {
    for (const host of [
      "localhost",
      "tv.local",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.20",
      "172.16.0.1",
      "172.31.255.254",
      "169.254.10.1",
      "100.101.102.103",
      "::1",
      "fd12:3456::1",
      "fe80::1",
    ]) {
      assert.equal(isPrivateHost(host), true, `${host} should count as private`);
    }
    for (const host of ["tv.example.com", "203.0.113.7", "8.8.8.8", "172.32.0.1", "172.15.0.1", "2001:db8::1"]) {
      assert.equal(isPrivateHost(host), false, `${host} should not count as private`);
    }
  });

  it("will not send the access token over cleartext to a public address", () => {
    // The token is a shared secret for something that spends money, and the
    // default transport is plain HTTP: on shared Wi-Fi anyone on the path can
    // read it straight off the wire.
    assert.equal(canSendTokenTo("http://192.168.1.20:8787"), true);
    assert.equal(canSendTokenTo("http://localhost:8787"), true);
    assert.equal(canSendTokenTo("https://tv.example.com"), true);
    assert.equal(canSendTokenTo("http://tv.example.com"), false);
    assert.equal(canSendTokenTo("http://203.0.113.7:8787"), false);
    assert.equal(canSendTokenTo(""), false);
    assert.equal(canSendTokenTo("javascript:alert(1)"), false);
  });

  it("warns about an address it cannot use, or would have to shout across the internet", () => {
    assert.equal(serverUrlWarning(""), null, "an unset server is not a warning");
    assert.equal(serverUrlWarning("http://192.168.1.20:8787"), null);
    assert.equal(serverUrlWarning("https://tv.example.com"), null);
    assert.match(serverUrlWarning("192.168.1.20:8787") ?? "", /not a server address/);
    assert.match(serverUrlWarning("http://tv.example.com") ?? "", /not on your own network/);
  });

  it("normalises a server URL without inventing one", () => {
    assert.equal(cleanServerUrl("http://a.example.com///"), "http://a.example.com");
    assert.equal(cleanServerUrl(undefined), "");
    assert.equal(cleanServerUrl({ toString: () => "http://x" }), "");
  });
});

