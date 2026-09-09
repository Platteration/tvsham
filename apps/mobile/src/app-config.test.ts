import assert from "node:assert/strict";
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

  it("declares Android cleartext through the config plugin app.json applies", () => {
    assert.ok(
      appJson.expo.plugins?.includes("./plugins/withLocalNetworkCleartext"),
      "the cleartext plugin must stay in the plugins list, or the mod never runs",
    );

    const plugin = require("../plugins/withLocalNetworkCleartext.js") as (
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
