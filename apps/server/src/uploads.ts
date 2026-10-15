/** Uploads keep their reservation through parsing, queuing and analysis. */
export class UploadAdmission {
  private active = 0;
  private bytes = 0;
  private readonly sessions = new Map<string, number>();

  tryAcquire(session: string, bytes: number, limits: { uploads: number; sessionUploads: number; bytes: number }): (() => void) | undefined {
    const count = this.sessions.get(session) ?? 0;
    if (this.active >= limits.uploads || count >= limits.sessionUploads || bytes > limits.bytes - this.bytes) return undefined;
    this.active++;
    this.bytes += bytes;
    this.sessions.set(session, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.bytes -= bytes;
      const remaining = (this.sessions.get(session) ?? 1) - 1;
      if (remaining) this.sessions.set(session, remaining);
      else this.sessions.delete(session);
    };
  }
}

export class UploadTooLarge extends Error {}
export class UploadAborted extends Error {}

/** Count actual bytes, including when Content-Length lies or is absent. */
export function boundedUpload(request: Request, maxBytes: number): { request: Request; dispose: () => Promise<void> } {
  if (!request.body) return { request, dispose: async () => {} };
  const reader = request.body.getReader();
  let bytes = 0;
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const closeReader = async () => {
    request.signal.removeEventListener("abort", abort);
    if (finished) return;
    finished = true;
    await reader.cancel().catch(() => {});
  };
  const abort = () => {
    if (finished) return;
    controller.error(new UploadAborted("upload cancelled"));
    void closeReader();
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
    },
    async pull(value) {
      if (finished) return;
      try {
        const chunk = await reader.read();
        if (finished) return;
        if (chunk.done) {
          finished = true;
          request.signal.removeEventListener("abort", abort);
          value.close();
          return;
        }
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          value.error(new UploadTooLarge("clip too large"));
          await closeReader();
          return;
        }
        value.enqueue(chunk.value);
      } catch (error) {
        if (!finished) value.error(error);
        await closeReader();
      }
    },
    cancel: closeReader,
  }, { highWaterMark: 0 });
  return {
    request: new Request(request, { body, duplex: "half" } as RequestInit),
    dispose: closeReader,
  };
}
