/**
 * What the clip route will hand to a form parser, decided before it does.
 *
 * An upload may be 80 MB, and the parser behind `parseBody` (undici's, inside
 * Node) spends very different amounts of work on different bytes. The bytes of
 * a file cost a native search and a copy; every part, every header line of a
 * part and every `name=value` pair of a urlencoded body costs JavaScript
 * objects and strings of its own, in one synchronous run that holds the event
 * loop. Measured against the real server, each body below the size cap that the
 * route used to parse whole:
 *
 *   one 80 MB clip                        /health answered within 1.3-2.4 s
 *   1.46 million empty multipart fields   /health held for 7.5 s
 *   8 million urlencoded pairs            /health held for 12.6 s, ~1 GB resident
 *   one part with 13 million header lines about 15 s to parse
 *
 * None of those spent a unit of DAILY_CLIP_LIMIT or a clip of the session (the
 * route answers "missing `clip` file field" before either is reached), so one
 * session could repeat it for as long as it liked, and every other caller's
 * upload and poll waited behind it.
 *
 * So the route takes one encoding, the one every client of it sends, and the
 * structure of the body - how many parts, how much header each part opens
 * with - is bounded before the parser sees it, by a scan that costs one native
 * search per part.
 */

/** Parts a clip upload may carry. The app sends two: the clip and its key. */
export const MAX_FORM_PARTS = 8;

/** Bytes of header one part may open with. A real part's are a few hundred. */
export const MAX_PART_HEADER_BYTES = 8 * 1024;

/**
 * Token boundaries (unquoted), and quoted ones with nothing to unescape: the
 * characters RFC 2046 allows in a boundary, less the space, so that there is
 * exactly one way to read the value.
 */
const CONTENT_TYPE =
  /^multipart\/form-data[ \t]*;[ \t]*boundary=(?:([A-Za-z0-9'+._-]{1,70})|"([A-Za-z0-9'()+_,./:=?-]{1,70})")[ \t]*$/i;

/**
 * The boundary of a clip upload, or null when its Content-Type is not one the
 * route will parse.
 *
 * Strict on purpose: the scan below has to find the same part boundaries the
 * parser will use, so this takes only the spellings where the boundary can be
 * read one way - `multipart/form-data` with that one parameter, as a token or as
 * a quoted string with no escapes in it. That is what every client of the route
 * sends: the app on iOS (70 characters of [A-Za-z0-9._-]) and on Android (a
 * UUID), browsers (`----WebKitFormBoundary…`), Node's own FormData and curl.
 * urlencoded, and every other type, is refused: the route takes a file.
 */
export function clipFormBoundary(contentType: string | undefined): string | null {
  if (typeof contentType !== "string") return null;
  const m = CONTENT_TYPE.exec(contentType);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

const CRLF = Buffer.from("\r\n");
const BLANK_LINE = Buffer.from("\r\n\r\n");

/**
 * Why a multipart body is not one the route will parse, in words, or null.
 *
 * Every part the parser reads opens right after a delimiter: the body's first
 * `--boundary` (after any CRLFs it skips), then each `CRLF--boundary` after
 * that. Counting every one of those in the body is a superset of the parts it
 * can produce, however the body is built, so it bounds them. And the parser
 * reads a part's headers no further than the first blank line (CRLF CRLF) after
 * its delimiter - it either ends the headers there or fails - so requiring that
 * blank line within MAX_PART_HEADER_BYTES of every delimiter bounds every
 * header block it can read. A closing `--boundary--` opens no part.
 */
export function clipFormProblem(body: Uint8Array, boundary: string): string | null {
  const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const first = Buffer.from(`--${boundary}`, "latin1");
  const later = Buffer.concat([CRLF, first]);

  let at = 0;
  while (bytes[at] === 0x0d && bytes[at + 1] === 0x0a) at += 2;
  if (!bytes.subarray(at, at + first.length).equals(first)) return "not a multipart/form-data body";

  // Where each delimiter ends. The boundary holds no CR or LF, so two
  // occurrences of CRLF--boundary cannot overlap and none is skipped here.
  const opens = [at + first.length];
  for (let from = opens[0]!; ; ) {
    const found = bytes.indexOf(later, from);
    if (found < 0) break;
    // One more delimiter than parts: the last one closes the body.
    if (opens.length > MAX_FORM_PARTS) return `more than ${MAX_FORM_PARTS} form fields`;
    from = found + later.length;
    opens.push(from);
  }

  for (const open of opens) {
    if (bytes[open] === 0x2d && bytes[open + 1] === 0x2d) continue;
    // CRLF, the headers, then the blank line that ends them.
    const window = bytes.subarray(open, open + CRLF.length + MAX_PART_HEADER_BYTES + BLANK_LINE.length);
    if (window.indexOf(BLANK_LINE) < 0) return "a form field's headers run on, or never end";
  }
  return null;
}
