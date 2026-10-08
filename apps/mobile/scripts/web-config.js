// The two values a website build is made for, checked in one place: app.config.js reads them into
// the Expo config, scripts/build-web.mjs writes them into the published files, and the tests read
// both through here. Plain CommonJS with no imports, because app.config.js is loaded by Expo's own
// config reader as well as by Node.

/**
 * The token the hosting files carry where the server's origin goes. It is not a valid CSP source
 * (an underscore is not a host character), so a site published without scripts/build-web.mjs
 * stamping it has a connect-src the browser ignores, which is connect-src 'none': the site fails
 * closed and talks to nothing, rather than to anything.
 */
const SERVER_ORIGIN_TOKEN = "TVSHAM_SERVER_ORIGIN";

/** Where the site's base path goes in index.html and 404.html; empty for a site at the root. */
const BASE_URL_TOKEN = "%BASE_URL%";

/**
 * The server address the website is built for: an absolute http(s) URL with a host and nothing a
 * browser would treat as credentials, a query or a fragment. '' when unset. Anything else throws,
 * because this value becomes the site's only connect-src and a typo here is a site that cannot
 * reach its server, or one whose policy names a host nobody meant.
 */
function serverUrlFrom(raw) {
  if (raw === undefined || raw === "") return "";
  const text = String(raw).trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`TVSHAM_SERVER_URL must be an absolute URL such as https://tvsham.example.com, not ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`TVSHAM_SERVER_URL must be http(s), not ${url.protocol}`);
  if (!url.hostname) throw new Error("TVSHAM_SERVER_URL needs a host");
  if (url.username || url.password) throw new Error("TVSHAM_SERVER_URL must not carry credentials: the access token is typed into Settings");
  if (url.search || url.hash) throw new Error("TVSHAM_SERVER_URL takes no query or fragment");
  // The text as given, less a trailing slash: the app appends /health, /sessions and so on to it.
  return text;
}

/** The server's origin, as the CSP names it: scheme, host and port. */
function serverOriginOf(serverUrl) {
  return new URL(serverUrl).origin;
}

/** The path the site is served under: '' for the root, else /one/or/more segments with no trailing slash. */
function baseUrlFrom(raw) {
  if (raw === undefined || raw === "" || raw === "/") return "";
  const text = String(raw);
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(text) || /(^|\/)\.\.?(\/|$)/.test(text)) {
    throw new Error(`WEB_BASE_URL must be a path such as /tvsham, not ${JSON.stringify(raw)}`);
  }
  return text;
}

module.exports = { SERVER_ORIGIN_TOKEN, BASE_URL_TOKEN, serverUrlFrom, serverOriginOf, baseUrlFrom };
