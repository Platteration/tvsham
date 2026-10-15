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

/** Where the site's base path goes in 404.html and .htaccess; empty for a site at the root. */
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

/** The loopback names: the one place a browser lets a page reach a server over plain http. */
function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * The server address a website build is made for: serverUrlFrom's, and https unless the server
 * is on this machine. The site's policy carries upgrade-insecure-requests, so a browser turns the
 * page's own http requests into https ones, and a page served over https may not call an http
 * server at all (mixed content). Measured in Chromium with the site and the server on a LAN address
 * over http: the stylesheet, the safety net and the bundle were requested over https, failed, and
 * the page never started. Only a loopback address is exempt from both, which is where the browser
 * suite runs. A build that cannot work stops here rather than reporting success.
 */
function siteServerUrlFrom(raw) {
  const text = serverUrlFrom(raw);
  if (text) {
    const url = new URL(text);
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      throw new Error(
        `TVSHAM_SERVER_URL must be https:// for a server on another machine, not ${JSON.stringify(text)}: ` +
          "the site's policy upgrades its requests to https and a browser blocks an https page's calls to an http server. " +
          "Put the server behind TLS (README, \"Run it as a website\"); plain http works only for 127.0.0.1 or localhost.",
      );
    }
  }
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

module.exports = { SERVER_ORIGIN_TOKEN, BASE_URL_TOKEN, serverUrlFrom, siteServerUrlFrom, serverOriginOf, baseUrlFrom };
