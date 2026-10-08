import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_FORM_PARTS, MAX_PART_HEADER_BYTES, clipFormBoundary, clipFormProblem } from "./form.js";

const enc = (s: string) => Buffer.from(s, "latin1");

/** What Node's own fetch makes of a FormData: the bytes and the Content-Type it sends. */
async function serialised(form: FormData): Promise<{ body: Uint8Array; type: string }> {
  const req = new Request("http://server.test/", { method: "POST", body: form });
  return { body: new Uint8Array(await req.arrayBuffer()), type: req.headers.get("content-type") ?? "" };
}

/** The entries the parser behind Hono's parseBody makes of a body, or null when it refuses it. */
async function parsed(body: Uint8Array, boundary: string): Promise<number | null> {
  try {
    const form = await new Response(body, {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    }).formData();
    return [...form.keys()].length;
  } catch {
    return null;
  }
}

/** A field part the way a client writes one. */
const field = (boundary: string, name: string, value: string, extra = "") =>
  `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n${extra}\r\n${value}\r\n`;

describe("the clip upload's encoding", () => {
  it("reads the boundary every client of the route sends", async () => {
    const node = await serialised(new FormData());
    const iosBoundary = "aZ09-_.".repeat(10); // RCTNetworking: 70 of [A-Za-z0-9-_.]
    const cases: Array<[string, string]> = [
      [node.type, node.type.split("boundary=")[1]!],
      ["multipart/form-data; boundary=----WebKitFormBoundaryq8T3ZbqZ1G0Xk9aB", "----WebKitFormBoundaryq8T3ZbqZ1G0Xk9aB"],
      ["multipart/form-data; boundary=----geckoformboundary9f8e7d6c5b4a39281706", "----geckoformboundary9f8e7d6c5b4a39281706"],
      ["multipart/form-data; boundary=3b7c5e1a-9d2f-4c6b-8a1e-0f9d8c7b6a5e", "3b7c5e1a-9d2f-4c6b-8a1e-0f9d8c7b6a5e"],
      [`multipart/form-data; boundary=${iosBoundary}`, iosBoundary],
      ["multipart/form-data; boundary=------------------------d74496d66958873e", "------------------------d74496d66958873e"],
      ['multipart/form-data; boundary="quoted:boundary/ok"', "quoted:boundary/ok"],
      ["Multipart/Form-Data;Boundary=x", "x"],
      ["multipart/form-data ; boundary=x ", "x"],
    ];
    for (const [type, boundary] of cases) assert.equal(clipFormBoundary(type), boundary, type);
  });

  it("refuses every other type, and every spelling with more than one reading", () => {
    for (const type of [
      undefined,
      "",
      "application/x-www-form-urlencoded",
      "text/plain;charset=UTF-8",
      "video/mp4",
      "application/json",
      "multipart/form-data",
      "multipart/form-data; boundary=",
      'multipart/form-data; boundary=""',
      "multipart/mixed; boundary=x",
      "multipart/form-data; charset=utf-8; boundary=x",
      "multipart/form-data; boundary=x; boundary=y",
      "multipart/form-data; boundary=a;b",
      'multipart/form-data; boundary="a\\"b"',
      "multipart/form-data; boundary=a b",
      `multipart/form-data; boundary=${"x".repeat(71)}`,
      "multipart/form-data; boundary=x\r\nX-Injected: 1",
    ]) {
      assert.equal(clipFormBoundary(type), null, String(type));
    }
  });
});

describe("the shape of a clip upload", () => {
  it("passes what Node's FormData sends for a clip and its key", async () => {
    const form = new FormData();
    form.set("clip", new Blob([new Uint8Array(4096).fill(7)], { type: "video/mp4" }), "Screen Recording 2026-10-08 at 10.11.12.mov");
    form.set("clipKey", "file:abc-123");
    const { body, type } = await serialised(form);
    assert.equal(clipFormProblem(body, clipFormBoundary(type)!), null);
  });

  it("passes the bodies the phone app sends, which the parser reads as two fields", async () => {
    const clip = "\u0000\u0001video\r\n--not-the-boundary\r\n\r\n";
    // iOS (RCTNetworking): lowercase header names, a 70-character boundary.
    const ios = "aZ09-_.".repeat(10);
    const iosBody = enc(
      `--${ios}\r\ncontent-disposition: form-data; name="clip"; filename="clip.mov"\r\ncontent-type: video/quicktime\r\n\r\n${clip}\r\n` +
        `--${ios}\r\ncontent-disposition: form-data; name="clipKey"\r\n\r\nfile:clip\r\n--${ios}--\r\n`,
    );
    // Android (OkHttp): a UUID boundary and a Content-Length on every part.
    const okhttp = "3b7c5e1a-9d2f-4c6b-8a1e-0f9d8c7b6a5e";
    const okhttpBody = enc(
      `--${okhttp}\r\nContent-Disposition: form-data; name="clip"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\nContent-Length: ${clip.length}\r\n\r\n${clip}\r\n` +
        `--${okhttp}\r\nContent-Disposition: form-data; name="clipKey"\r\nContent-Length: 9\r\n\r\nfile:clip\r\n--${okhttp}--\r\n`,
    );
    for (const [boundary, body] of [[ios, iosBody], [okhttp, okhttpBody]] as const) {
      assert.equal(clipFormProblem(body, boundary), null);
      assert.equal(await parsed(body, boundary), 2, "and these are bodies the parser really reads");
    }
  });

  it(`refuses more than ${MAX_FORM_PARTS} fields`, async () => {
    const b = "B0undary";
    const body = (n: number) => enc(Array.from({ length: n }, (_, i) => field(b, `f${i}`, "")).join("") + `--${b}--\r\n`);
    assert.equal(clipFormProblem(body(MAX_FORM_PARTS), b), null);
    assert.equal(await parsed(body(MAX_FORM_PARTS), b), MAX_FORM_PARTS);
    assert.equal(clipFormProblem(body(MAX_FORM_PARTS + 1), b), `more than ${MAX_FORM_PARTS} form fields`);
    // What this is for: a body of nothing but empty fields, which the parser would
    // otherwise turn into an object each.
    assert.equal(clipFormProblem(body(50_000), b), `more than ${MAX_FORM_PARTS} form fields`);
  });

  it("refuses a field whose headers run on", () => {
    const b = "B0undary";
    const withHeaders = (bytes: number) =>
      enc(field(b, "clip", "x", "X: y\r\n".repeat(Math.ceil(bytes / 6))) + `--${b}--\r\n`);
    assert.equal(clipFormProblem(withHeaders(MAX_PART_HEADER_BYTES - 200), b), null);
    assert.equal(clipFormProblem(withHeaders(MAX_PART_HEADER_BYTES + 200), b), "a form field's headers run on, or never end");
    // The parser ends a header line at a CR followed by anything, not only at CRLF,
    // so lines that never contain a CRLF are header lines to it all the same.
    const quirky = enc(`--${b}\r\nContent-Disposition: form-data; name="clip"\r\n${"X:y\rZ".repeat(100_000)}\r\n\r\nx\r\n--${b}--\r\n`);
    assert.equal(clipFormProblem(quirky, b), "a form field's headers run on, or never end");
    // ...and a body that stops after a delimiter has headers that never end.
    assert.equal(clipFormProblem(enc(`--${b}\r\n`), b), "a form field's headers run on, or never end");
  });

  it("refuses a body that does not open with its own boundary", () => {
    assert.equal(clipFormProblem(enc("clip=x&clipKey=y"), "B0undary"), "not a multipart/form-data body");
    assert.equal(clipFormProblem(enc(`--other\r\n`), "B0undary"), "not a multipart/form-data body");
    // The parser skips CRLFs before the first delimiter, and so does the scan.
    assert.equal(clipFormProblem(enc(`\r\n\r\n${field("B0undary", "a", "1")}--B0undary--`), "B0undary"), null);
  });

  it("bounds what the real parser makes of any body it lets through", async () => {
    // The claim the route rests on, held against the parser itself rather than a
    // model of it: whatever the bytes, a body clipFormProblem passes is one the
    // parser turns into at most MAX_FORM_PARTS entries. The bodies are fields,
    // some written the way clients write them and some out of the parser's
    // quirks - header lines ended by a CR and any byte, or by two LFs; no blank
    // line at all; a delimiter inside a value; the closing delimiter mid-body -
    // so that many parse, into anything from none to twenty entries.
    const b = "Bq7";
    let seed = 0x5eed;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pick = <T>(list: readonly T[]): T => list[random(list.length)]!;
    const ends = ["\r\n", "\rZ", "\n\n"] as const;
    const quirky = (i: number) => {
      const lines = [`Content-Disposition: form-data; name="q${i}"`];
      if (random(2)) lines.push(pick(["X:y", "Content-Type: a/b", `X: ${"h".repeat(random(9000))}`]));
      const head = lines.map((l) => l + pick(ends)).join("");
      const value = pick(["v", "", `a\r\n--${b}\r\nContent-Disposition: form-data; name="in"\r\n\r\nb`, `--${b}--`, "\r\n\r\n"]);
      return `${pick([`--${b}\r\n`, `--${b}`, `\r\n--${b}\r\n`])}${head}${pick(["\r\n", "", "\r\n\r\n"])}${value}\r\n`;
    };
    const seen = { accepted: 0, acceptedNearTheBound: 0, refusedOverTheBound: 0 };
    for (let n = 0; n < 3000; n++) {
      const count = random(21);
      const fields = Array.from({ length: count }, (_, i) => (random(10) < 7 ? field(b, `f${i}`, "v") : quirky(i)));
      const body = enc(fields.join("") + `--${b}--\r\n`);
      const entries = await parsed(body, b);
      if (clipFormProblem(body, b) === null) {
        seen.accepted++;
        if (entries !== null) {
          assert.ok(entries <= MAX_FORM_PARTS, `${entries} entries from ${JSON.stringify(fields.join(""))}`);
          if (entries >= MAX_FORM_PARTS - 2) seen.acceptedNearTheBound++;
        }
      } else if (entries !== null && entries > MAX_FORM_PARTS) {
        seen.refusedOverTheBound++;
      }
    }
    // The fuzz has to reach the bound from both sides to mean anything.
    for (const [what, count] of Object.entries(seen)) assert.ok(count > 50, `${what}: ${count}`);
  });
});
