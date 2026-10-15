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
 * The image is built from the committed lockfile and nothing else, with no
 * dependency's lifecycle script run, and ships only what the server runs. A
 * `|| npm install` fallback re-resolves a drifted lockfile from the registry,
 * a second install with scripts on undoes `--ignore-scripts`, and copying the
 * whole build tree ships typescript, tsx and the rest of the dev tree into the
 * container that decodes attacker-supplied video. `docker build` in CI passes
 * with every one of those, so they are read here.
 */
describe("the server image", () => {
  const compose = readFileSync(composePath, "utf8");
  // One instruction per entry: continuation lines joined, comments dropped.
  const instructions = readFileSync(dockerfilePath, "utf8")
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const stageStarts = instructions.flatMap((line, i) => (/^FROM\b/i.test(line) ? [i] : []));
  const buildStage = instructions.slice(stageStarts[0], stageStarts[1]);
  const runtimeStage = instructions.slice(stageStarts[stageStarts.length - 1]);
  const runs = instructions.filter((line) => /^RUN\b/.test(line));
  const npmCommands = runs.flatMap((line) => line.replace(/^RUN\s+/, "").split(/&&|\|\||;/).map((part) => part.trim()).filter((part) => /^npm\b/.test(part)));

  it("has a build stage and a runtime stage", () => {
    assert.equal(stageStarts.length, 2);
  });

  it("installs from the lockfile once, by name, with scripts off", () => {
    assert.ok(
      buildStage.some((line) => /^COPY\b/.test(line) && line.split(/\s+/).slice(1, -1).includes("package-lock.json")),
      "the lockfile is copied by name, so a context without one stops the build",
    );
    const installs = npmCommands.filter((cmd) => /^npm (ci|install|i|add|update|upgrade)\b/.test(cmd));
    assert.equal(installs.length, 1, `one install, found: ${installs.join(" | ")}`);
    const install = installs[0] ?? "";
    assert.match(install, /^npm ci\b/, "the install is npm ci, which refuses a lockfile that disagrees");
    assert.match(install, /\s--ignore-scripts\b/, "no dependency's lifecycle script runs");
    assert.match(install, /\s--include=dev\b/, "tsc needs the dev tree, asked for by name");
    for (const line of runs.filter((run) => /\bnpm\b/.test(run))) {
      assert.ok(!line.includes("||"), `no fallback after an npm step: ${line}`);
    }
  });

  it("prunes the dev tree after the build and ships only what the server runs", () => {
    const build = npmCommands.findIndex((cmd) => /^npm run build\b/.test(cmd));
    const prune = npmCommands.findIndex((cmd) => /^npm prune\b/.test(cmd) && /\s--omit=dev\b/.test(cmd) && /\s--ignore-scripts\b/.test(cmd));
    assert.ok(build !== -1, "the server is compiled in the build stage");
    assert.ok(prune > build, "then the dev tree is pruned, scripts still off");
    const copied = runtimeStage
      .filter((line) => /^COPY\b/.test(line))
      .map((line) => line.split(/\s+/).filter((word) => !word.startsWith("--")).slice(1, -1));
    assert.ok(copied.length > 0, "the runtime stage copies from the build");
    for (const sources of copied) {
      for (const source of sources) {
        assert.ok(
          !/^\/app\/?$/.test(source) && !/\/src\/?$/.test(source),
          `the runtime stage copies named outputs, never the whole build tree or the sources: ${source}`,
        );
      }
    }
  });

  it("carries the kit the server mounts, and a place for its records that outlives the container", () => {
    // dist/account.js imports ../kit/app.js, so the kit sits beside dist in the image, as it is
    // in the repository; a build that left it out compiles and starts nowhere.
    const copied = runtimeStage.filter((line) => /^COPY\b/.test(line)).map((line) => line.split(/\s+/).filter((word) => !word.startsWith("--")).slice(1));
    assert.ok(
      copied.some(([from, to]) => from === "/app/apps/server/kit" && to === "./apps/server/kit"),
      "the runtime stage copies apps/server/kit beside apps/server/dist",
    );
    // KIT_DATA_DIR is under a directory the image hands the node user, which compose mounts as a
    // named volume: a fresh volume takes that directory's owner, so the unprivileged process can
    // write its records there, and they survive the container being recreated.
    const env = runtimeStage.find((line) => /^ENV\b/.test(line)) ?? "";
    const dataDir = /\bKIT_DATA_DIR=(\S+)/.exec(env)?.[1];
    assert.equal(dataDir, "/var/lib/tvsham/account");
    assert.ok(
      runtimeStage.some((line) => /^RUN mkdir -p .*\/var\/lib\/tvsham\b.*&& chown node:node .*\/var\/lib\/tvsham\b/.test(line)),
      "the image makes the records' parent directory the node user's",
    );
    assert.match(compose, /^ {6}- account:\/var\/lib\/tvsham$/m, "compose mounts a named volume there");
    assert.match(compose, /^volumes:\n {2}account:$/m);
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
