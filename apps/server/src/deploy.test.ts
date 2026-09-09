import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const composePath = new URL("../../../docker-compose.yml", import.meta.url);

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
