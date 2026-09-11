import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { UPLOAD_DEADLINE_MS } from "@tvsham/shared";
import { config } from "./config.js";

const composePath = new URL("../../../docker-compose.yml", import.meta.url);
const dockerfilePath = new URL("../Dockerfile", import.meta.url);

/**
 * The quickstart in the README is `docker compose up --build`, and the shipped
 * compose file is therefore the deployment most people get. Docker publishes a
 * port by writing its own iptables DNAT rules, which bypass ufw and firewalld,
 * so an unqualified mapping puts the server on every interface of the host
 * whatever the host firewall says - and by default it has no APP_TOKEN and no
 * daily cap, so anyone who finds the port can spend the operator's Claude
 * budget and read back what the household watched.
 */
describe("docker compose", () => {
  const compose = readFileSync(composePath, "utf8");

  it("binds the listener to loopback unless the deployment widens it", () => {
    // SEC-1 bound the published port; the listener itself still took every
    // interface, so `npm run server` on a laptop put an unauthenticated server
    // on every cafe and hotel network it joined - and the banner said
    // localhost. The container is the one place that must bind its own
    // interfaces, because there the published port above is the boundary.
    assert.equal(config.host, "127.0.0.1", "the default bind address must be loopback");
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    assert.match(dockerfile, /^ENV .*\bHOST=0\.0\.0\.0\b/m, "the image must still bind inside the container");
  });

  it("gives the container that decodes uploads nothing it does not need", () => {
    // Defence in depth against a bug in ffmpeg rather than in this code: the
    // process binds an unprivileged port as an unprivileged user, so it needs
    // no capability at all and no way to acquire one.
    assert.match(compose, /cap_drop:\s*\n\s*- ALL/, "capabilities must be dropped");
    assert.match(compose, /no-new-privileges:true/, "privilege escalation must be off");
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    assert.ok(
      !/apt-get install[^\n]*\bcurl\b/.test(dockerfile),
      "curl is an exfiltration tool next to the API key; the health check uses node",
    );
  });

  it("publishes the server on loopback only", () => {
    const published = compose
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^-\s*"?\d[\d.:]*:\d+(:\d+)?"?/.test(line));

    assert.ok(published.length > 0, "the compose file should still publish a port");
    for (const line of published) {
      assert.match(
        line,
        /^-\s*"?127\.0\.0\.1:/,
        `published ports must be bound to loopback, found: ${line}`,
      );
    }
  });
});

/**
 * The server and the app each have a deadline for the same upload, and they
 * used to be set independently: the server gave up on a body at 120 s while the
 * app was still willing to send for 180. An 80 MB screen recording - the size
 * the server itself accepts, off the library, which is one of the app's two
 * headline flows - needs a sustained 5.3 Mbit/s to arrive inside 120 s. Past
 * that the body is cut off mid-upload, which the app can only see as a
 * transport failure: it queues the clip and every retry meets the same wall,
 * with nothing on screen to say why.
 */
describe("upload deadlines", () => {
  it("waits for a body longer than the app will spend sending one", () => {
    assert.ok(
      config.requestTimeoutMs > UPLOAD_DEADLINE_MS,
      `the server gives up at ${config.requestTimeoutMs}ms, the app at ${UPLOAD_DEADLINE_MS}ms`,
    );
    // Node checks for expiry on its own 30 s interval, so a margin below that
    // would still be the server dropping a body the app is sending.
    assert.ok(config.requestTimeoutMs - UPLOAD_DEADLINE_MS >= 30_000, "and by more than node's own check interval");
    // Node refuses to start when the headers wait is the longer of the two.
    assert.ok(config.headersTimeoutMs <= config.requestTimeoutMs);
  });
});
