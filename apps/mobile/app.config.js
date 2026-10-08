// app.json is the configuration. This adds the two values only the website build sets, read from
// the environment of the one command that builds the site (scripts/build-web.mjs):
//
//   TVSHAM_SERVER_URL  the recognition server the site talks to. It becomes extra.serverUrl, the
//                      built-in server address the app already reads, and the build writes the
//                      same origin into the site's Content-Security-Policy as its only connect-src.
//   WEB_BASE_URL       the path the site is served under (/tvsham for example.com/tvsham/); unset,
//                      the site is the root of its own origin, which is what the README advises.
//
// With neither set (the dev server, native builds, CI's bundle check, the config test), app.json
// comes through exactly as written.
const { serverUrlFrom, baseUrlFrom } = require("./scripts/web-config.js");

module.exports = ({ config }) => {
  const serverUrl = serverUrlFrom(process.env.TVSHAM_SERVER_URL);
  const baseUrl = baseUrlFrom(process.env.WEB_BASE_URL);
  if (!serverUrl && !baseUrl) return config;
  return {
    ...config,
    ...(serverUrl ? { extra: { ...config.extra, serverUrl } } : {}),
    ...(baseUrl ? { experiments: { ...config.experiments, baseUrl } } : {}),
  };
};
