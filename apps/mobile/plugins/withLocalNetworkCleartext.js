/**
 * Declare the app's cleartext policy for Android instead of inheriting whatever
 * the prebuild template happens to default to.
 *
 * The server is one the user runs themselves, usually on their own LAN, where
 * there is no certificate to be had - so the app has to be able to reach an
 * http:// address. Android has blocked cleartext by default since API 28, and
 * Expo Go relaxes it, which is exactly the combination that works all through
 * development and then fails on the first TestFlight or Play build.
 *
 * The app's own rule is the narrower one and is enforced in `src/settings.ts`:
 * the access token is never sent over http: to anything outside a private
 * network, and Settings warns when the configured server is in that position.
 */
const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

module.exports = function withLocalNetworkCleartext(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    application.$["android:usesCleartextTraffic"] = "true";
    return cfg;
  });
};
