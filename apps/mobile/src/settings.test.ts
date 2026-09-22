import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACCENT_NAMES } from "./palette.js";
import {
  APPEARANCE_NAMES,
  DEFAULT_SETTINGS,
  PREFERENCE_FIELDS,
  REDUCE_MOTION_NAMES,
  canSendTokenTo,
  cleanServerUrl,
  cleanSettings,
  isPrivateHost,
  resetPreferences,
  serverUrlWarning,
  shouldReduceMotion,
  type Settings,
} from "./settings.js";

/** A record as it comes back from storage, read with the defaults in force. */
const clean = (raw: unknown) => cleanSettings(raw, DEFAULT_SETTINGS);
/** Settings as they might come back from an older install: anything goes. */
const stored = (patch: Record<string, unknown>) => ({ ...DEFAULT_SETTINGS, ...patch });

describe("settings validation", () => {
  it("passes sound settings through untouched", () => {
    const s = stored({ serverUrl: "http://host:8787", token: "t", appearance: "light", accent: "forest" });
    assert.deepEqual(clean(s), s);
  });

  it("round-trips the defaults and every value of every enum", () => {
    // A table member the validator does not carry would be dropped on every
    // launch, silently: the user picks it, the app forgets it. The lists are
    // literals, not the exported name arrays: those are derived from the very
    // tables under test, so a member dropped from a table would drop out of
    // the loop with it and the test would pass over the hole.
    assert.deepEqual(clean(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
    for (const appearance of ["system", "light", "dark"] as const) {
      assert.equal(clean(stored({ appearance })).appearance, appearance);
    }
    for (const reduceMotion of ["system", "on", "off"] as const) {
      assert.equal(clean(stored({ reduceMotion })).reduceMotion, reduceMotion);
    }
    for (const accent of ["midnight", "sunset", "forest", "mono"] as const) {
      assert.equal(clean(stored({ accent })).accent, accent);
    }
    for (const haptics of [true, false]) {
      assert.equal(clean(stored({ haptics })).haptics, haptics);
    }
    // ...and the exported name arrays are those same literals, so a screen that
    // builds its control from them offers exactly what the validator keeps.
    assert.deepEqual(APPEARANCE_NAMES, ["system", "light", "dark"]);
    assert.deepEqual(REDUCE_MOTION_NAMES, ["system", "on", "off"]);
    assert.deepEqual(ACCENT_NAMES, ["midnight", "sunset", "forest", "mono"]);
  });

  it("falls back to a known accent", () => {
    assert.equal(clean(stored({ accent: "chartreuse" })).accent, "midnight");
    assert.equal(clean(stored({ accent: undefined })).accent, "midnight");
    assert.equal(clean(stored({ accent: 7 })).accent, "midnight");
  });

  it("falls back to following the system appearance", () => {
    assert.equal(clean(stored({ appearance: "sepia" })).appearance, "system");
    assert.equal(clean(stored({ appearance: null })).appearance, "system");
    assert.equal(clean(stored({ appearance: "dark" })).appearance, "dark");
  });

  it("falls back to following the system for reduced motion", () => {
    assert.equal(clean(stored({ reduceMotion: "always" })).reduceMotion, "system");
    assert.equal(clean(stored({ reduceMotion: true })).reduceMotion, "system");
    assert.equal(clean(stored({ reduceMotion: "on" })).reduceMotion, "on");
  });

  it("takes vibration only as a boolean", () => {
    for (const bad of ["yes", 1, null, undefined, {}]) {
      assert.equal(clean(stored({ haptics: bad })).haptics, true, String(bad));
    }
    assert.equal(clean(stored({ haptics: false })).haptics, false);
  });

  it("does not take a name off Object.prototype as any enum value", () => {
    // A stored record is an object somebody else's version of the app wrote,
    // and on a shared storage origin possibly no version of it. "constructor"
    // and its siblings used to pass the accent check and reach the lookup
    // table as a colour that is not one. Built with JSON.parse, not a literal:
    // {__proto__: "x"} as a literal sets the prototype, while JSON.parse makes
    // an own "__proto__" key, which is the case a stored record presents.
    for (const inherited of Object.getOwnPropertyNames(Object.prototype)) {
      const name = JSON.stringify(inherited);
      const raw = JSON.parse(
        `{"appearance":${name},"accent":${name},"reduceMotion":${name},"unlockedAccents":[${name},"forest"]}`,
      );
      assert.deepEqual(clean(raw), { ...DEFAULT_SETTINGS, unlockedAccents: ["forest"] }, inherited);
      assert.equal(clean(JSON.parse(`{"haptics":${name}}`)).haptics, true, inherited);
    }
  });

  it("refuses an object where a string is expected rather than coercing it", () => {
    // Used as a property key, an object is coerced through its own toString,
    // which a stored record can make throw.
    const hostile = JSON.parse('{"toString":"x"}');
    const s = clean({ appearance: hostile, accent: hostile, reduceMotion: hostile, unlockedAccents: [hostile] });
    assert.deepEqual(s, DEFAULT_SETTINGS);
  });

  it("keeps only accent packs it recognises, and never leaves the user with none", () => {
    assert.deepEqual(clean(stored({ unlockedAccents: ["forest", "chartreuse"] })).unlockedAccents, ["forest"]);
    assert.deepEqual(clean(stored({ unlockedAccents: [] })).unlockedAccents, DEFAULT_SETTINGS.unlockedAccents);
    assert.deepEqual(clean(stored({ unlockedAccents: "all" })).unlockedAccents, DEFAULT_SETTINGS.unlockedAccents);
  });

  it("coerces non-string server details to empty rather than crashing later", () => {
    const s = clean(stored({ serverUrl: 42, token: null }));
    assert.equal(s.serverUrl, "");
    assert.equal(s.token, "");
  });

  it("keeps only server URLs that are actually web addresses", () => {
    // Everything the app records goes to this address and everything it renders
    // comes back from it, so a stored value that is not http(s) is dropped
    // rather than handed to fetch.
    assert.equal(clean(stored({ serverUrl: "https://tv.example.com" })).serverUrl, "https://tv.example.com");
    assert.equal(clean(stored({ serverUrl: "  http://192.168.1.20:8787/  " })).serverUrl, "http://192.168.1.20:8787");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "tvsham://x", "192.168.1.20:8787", "not a url", "http://"]) {
      assert.equal(clean(stored({ serverUrl: bad })).serverUrl, "", `${bad} must not be kept`);
    }
  });

  it("survives a completely empty object, and anything that is not one", () => {
    assert.deepEqual(clean({}), DEFAULT_SETTINGS);
    for (const notARecord of [null, undefined, "settings", 3, [], true]) {
      assert.deepEqual(clean(notARecord), DEFAULT_SETTINGS, String(notARecord));
    }
  });

  it("falls back field by field to the settings in force, never to a constant", () => {
    // The fallback is what the app is running with: the defaults at launch,
    // the previous settings on an update. One bad field costs one field.
    const inForce: Settings = {
      serverUrl: "http://192.168.1.20:8787",
      token: "secret",
      appearance: "dark",
      accent: "forest",
      unlockedAccents: ["midnight", "forest"],
      haptics: false,
      reduceMotion: "on",
    };
    assert.deepEqual(cleanSettings({}, inForce), inForce, "an empty record changes nothing");
    assert.deepEqual(
      cleanSettings({ appearance: "sepia", accent: 7, haptics: "no", reduceMotion: [] }, inForce),
      inForce,
      "a bad field keeps the value in force",
    );
    const one = cleanSettings({ appearance: "light" }, inForce);
    assert.deepEqual(one, { ...inForce, appearance: "light" }, "a good field replaces only itself");
    // The list is copied, not shared, so a later write cannot reach back.
    assert.notEqual(cleanSettings({}, inForce).unlockedAccents, inForce.unlockedAccents);
  });
});

describe("reduced motion", () => {
  it("is the setting when pinned, and the phone's answer when following the system", () => {
    assert.equal(shouldReduceMotion("on", false), true);
    assert.equal(shouldReduceMotion("off", true), false);
    assert.equal(shouldReduceMotion("system", true), true);
    assert.equal(shouldReduceMotion("system", false), false);
  });
});

describe("reset to defaults", () => {
  // Every field away from its default, so a reset that touches a field shows.
  const current: Settings = {
    serverUrl: "http://192.168.1.20:8787",
    token: "secret",
    appearance: "light",
    accent: "forest",
    unlockedAccents: ["midnight", "forest"],
    haptics: false,
    reduceMotion: "on",
  };

  it("puts the preferences back and leaves the connection and the purchases alone", () => {
    const reset = resetPreferences(current);
    assert.deepEqual(reset, {
      ...current,
      appearance: "system",
      accent: "midnight",
      haptics: true,
      reduceMotion: "system",
    });
    assert.equal(reset.serverUrl, current.serverUrl, "the server address is configuration, not a preference");
    assert.equal(reset.token, current.token, "the token is configuration, not a preference");
    assert.deepEqual(reset.unlockedAccents, current.unlockedAccents, "unlocked accents are purchases");
    assert.notEqual(reset.unlockedAccents, current.unlockedAccents, "...copied, not shared");
  });

  it("touches exactly the fields PREFERENCE_FIELDS names", () => {
    const reset = resetPreferences(current);
    const changed = (Object.keys(current) as Array<keyof Settings>).filter(
      (k) => JSON.stringify(reset[k]) !== JSON.stringify(current[k]),
    );
    assert.deepEqual(changed.sort(), [...PREFERENCE_FIELDS].sort());
    assert.deepEqual(PREFERENCE_FIELDS, ["appearance", "accent", "haptics", "reduceMotion"]);
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
