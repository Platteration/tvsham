/**
 * Declare the app's Android cleartext policy explicitly, rather than inheriting
 * whatever the prebuild template happens to default to.
 *
 * The server is one the user runs themselves, usually on their own LAN, where
 * there is no certificate to be had - so the app has to be able to reach an
 * http:// address. Android has blocked cleartext by default since API 28, and
 * Expo Go relaxes it, which is exactly the combination that works all through
 * development and then fails on the first TestFlight or Play build.
 *
 * Read the name literally: this permits cleartext to *every* host, not only to
 * a local one. There is no narrower Android setting that would do - a
 * network-security-config permits cleartext per domain, and the addresses this
 * app actually needs are private IPv4 literals, which a domain list cannot
 * express. So the two platforms do not agree about this app: iOS declares only
 * NSAllowsLocalNetworking, which exempts .local, unqualified names and private
 * literals and nothing else, while Android permits a public http:// server too.
 *
 * The app's own rule is narrower than Android's but narrower still than iOS's
 * in only one respect: `src/settings.ts` refuses to send the access token over
 * http: to anything outside a private network, and Settings warns about such an
 * address - but the clip itself is still sent. README.md says so where it tells
 * you to put TLS in front of a public server.
 */
const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    application.$["android:usesCleartextTraffic"] = "true";
    return cfg;
  });
};
