import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);

/**
 * The app's server is one the user runs themselves, usually on their own LAN,
 * where there is no certificate to be had - so it has to be reachable over
 * http://. Expo Go relaxes iOS App Transport Security and development on
 * Android is permissive, which is exactly the combination that works all the
 * way through development and then fails on the first release build. Both
 * platforms' policies are therefore declared here rather than inherited from
 * whatever a prebuild template happens to default to.
 */
describe("cleartext policy", () => {
  const appJson = require("../app.json") as {
    expo: {
      ios?: { infoPlist?: Record<string, unknown> };
      plugins?: unknown[];
    };
  };

  it("declares iOS App Transport Security for local networking", () => {
    const ats = appJson.expo.ios?.infoPlist?.NSAppTransportSecurity as
      | { NSAllowsLocalNetworking?: boolean; NSAllowsArbitraryLoads?: boolean }
      | undefined;
    assert.ok(ats, "app.json must declare NSAppTransportSecurity");
    assert.equal(ats.NSAllowsLocalNetworking, true);
    // Local networking only: ATS stays on for the public internet, which is
    // where the app refuses to send the token in the clear anyway.
    assert.notEqual(ats.NSAllowsArbitraryLoads, true);
  });

  // Android's is the wider of the two and cannot be narrowed: a
  // network-security-config permits cleartext per domain, and what this app
  // needs is private IPv4 literals, which a domain list cannot express. Pinned
  // here with that said out loud, rather than sitting next to the assertion
  // above looking like its equivalent.
  it("declares Android cleartext through the config plugin app.json applies", () => {
    assert.ok(
      appJson.expo.plugins?.includes("./plugins/withCleartextTraffic"),
      "the cleartext plugin must stay in the plugins list, or the mod never runs",
    );

    const plugin = require("../plugins/withCleartextTraffic.js") as (
      config: Record<string, unknown>,
    ) => { mods: { android: { manifest: (c: Record<string, unknown>) => Promise<{ modResults: Manifest }> } } };
    const configured = plugin({ name: "TVsham", slug: "tvsham" });
    const modResults: Manifest = {
      manifest: { $: {}, application: [{ $: { "android:name": ".MainApplication" } }] },
    };
    return configured.mods.android
      .manifest({ ...configured, modResults })
      .then((out) => {
        assert.equal(out.modResults.manifest.application?.[0]?.$["android:usesCleartextTraffic"], "true");
      });
  });
});

interface Manifest {
  manifest: {
    $: Record<string, string>;
    application?: Array<{ $: Record<string, string> }>;
  };
}

/**
 * store.ts imports AsyncStorage and expo-secure-store, so it cannot be loaded
 * here the way the pure modules are. The one thing worth pinning about it is a
 * single argument, which is readable from the source.
 */
describe("token storage", () => {
  const source = readFileSync(new URL("./store.ts", import.meta.url).pathname, "utf8");

  it("keeps the token off any device but this one", () => {
    // The keychain was chosen to keep the token out of device backups, and its
    // default accessibility class is in them: WHEN_UNLOCKED is included in an
    // encrypted backup and restored onto whatever device that backup is put
    // on. Only the THIS_DEVICE_ONLY classes stay here.
    assert.match(
      source,
      /keychainAccessible:\s*SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/,
      "the token's accessibility class must be declared, not defaulted",
    );
    const writes = source.match(/SecureStore\.setItemAsync\([^)]*\)/g) ?? [];
    assert.ok(writes.length > 0, "the token is still written to the keychain");
    for (const write of writes) {
      assert.match(write, /TOKEN_OPTIONS/, `every write must carry the option: ${write}`);
    }
  });
});
