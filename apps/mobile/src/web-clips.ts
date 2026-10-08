/**
 * Videos picked in a browser, held by the address the picker gave them.
 *
 * On a phone a clip is a file on disk, and React Native's fetch streams it
 * from a `{ uri, name, type }` part. A browser has no such part: expo-image-picker
 * hands back a `blob:` address and the File behind it, and the upload needs the
 * File itself. Fetching the `blob:` address back would work too, but only with
 * `blob:` in the site's connect-src, which is otherwise the recognition server
 * alone. So the screen keeps the File here, the upload takes it from here, and
 * the run lets it go when it ends, revoking the address with it.
 *
 * Free of React Native and the DOM's types beyond Blob, so it can be tested bare.
 */

const held = new Map<string, Blob>();

/** Keep `file` for the upload that will ask for `uri`. */
export function holdClipFile(uri: string, file: Blob): void {
  held.set(uri, file);
}

/** The file picked under `uri`, if it is still held. */
export function clipFileFor(uri: string): Blob | undefined {
  return held.get(uri);
}

/** The file's own name when it has one, else `fallback`: the server takes the extension from it. */
export function clipFileName(file: Blob, fallback: string): string {
  const name = (file as Blob & { name?: unknown }).name;
  return typeof name === "string" && name ? name : fallback;
}

/** Let the file go and revoke its address: nothing will upload it again. */
export function releaseClipFile(uri: string): void {
  if (!held.delete(uri)) return;
  try {
    URL.revokeObjectURL(uri);
  } catch {
    /* not an object URL, or already revoked */
  }
}
