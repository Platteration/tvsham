import AsyncStorage from "@react-native-async-storage/async-storage";
import { Directory, File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";
import type { CaptureSource, RecognitionResult } from "@tvsham/shared";
import { ApiError, createSession, endSession, uploadClip } from "./api";
import { isHopeless } from "./queue-policy";
import { cleanQueuedClips } from "./shapes";
import { setLastResult } from "./store";

/**
 * Clips recorded while the server was unreachable. A clip is only worth keeping
 * if its file survives, so each one is moved out of the cache (which the OS may
 * clear) into the app's own directory before it is queued.
 */
export interface QueuedClip {
  id: string;
  /** File URI inside the app's document directory. */
  uri: string;
  source: CaptureSource;
  hint?: string;
  queuedAt: string;
  /** Why it did not go through the first time. */
  reason: string;
}

const QUEUE_KEY = "tvsham.queue.v1";
const QUEUE_DIR = "pending-clips";
/** Beyond this the queue is more of a disk leak than a feature. */
const MAX_QUEUED = 10;

type Listener = () => void;
let queue: QueuedClip[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

async function persist(): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  emit();
}

function pendingDir(): Directory {
  const dir = new Directory(Paths.document, QUEUE_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export async function loadQueue(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    // Coerced, not cast: runFlush walks this list unattended on every
    // foreground event and hands each entry's uri and source to the server.
    const parsed = cleanQueuedClips(raw ? JSON.parse(raw) : []);
    // Drop anything whose file the OS reclaimed while we were away.
    queue = parsed.filter((c) => fileExists(c.uri));
    emit();
    if (parsed.length !== queue.length) await persist();
  } catch {
    queue = [];
  }
}

function fileExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

export function useQueue(): QueuedClip[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => queue,
    () => queue,
  );
}

export function queueLength(): number {
  return queue.length;
}

/** Keep a clip that could not be uploaded, so it can be identified later. */
export async function enqueue(
  clipUri: string,
  source: CaptureSource,
  reason: string,
  hint?: string,
): Promise<QueuedClip | null> {
  try {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // The extension is derived from a path, so it is stripped to letters and
    // digits: a separator here would place the file outside pending-clips.
    const suffix = clipUri.split(".").pop()?.replace(/[^A-Za-z0-9]/g, "").slice(0, 4);
    const name = `${id}.${suffix || "mp4"}`;
    const source_ = new File(clipUri);
    if (!source_.exists) return null;
    const target = new File(pendingDir(), name);
    await source_.move(target);
    const item: QueuedClip = {
      id,
      uri: target.uri,
      source,
      queuedAt: new Date().toISOString(),
      reason,
      ...(hint ? { hint } : {}),
    };
    const next = [item, ...queue];
    // Anything pushed off the end has no way back, so remove its file too.
    for (const dropped of next.slice(MAX_QUEUED)) discardFile(dropped.uri);
    queue = next.slice(0, MAX_QUEUED);
    await persist();
    return item;
  } catch {
    return null;
  }
}

/** Delete a recording nothing refers to any more. Exported for the identification loop. */
export function discardFile(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    /* already gone */
  }
}

export async function remove(id: string): Promise<void> {
  const item = queue.find((c) => c.id === id);
  if (item) discardFile(item.uri);
  queue = queue.filter((c) => c.id !== id);
  await persist();
}

export async function clearQueue(): Promise<void> {
  for (const c of queue) discardFile(c.uri);
  queue = [];
  await persist();
}

export interface FlushOutcome {
  identified: number;
  failed: number;
  /** The last result, identified or not, so the caller can show it. */
  last?: RecognitionResult;
}

let inFlight: Promise<FlushOutcome> | null = null;

/**
 * Try every queued clip, oldest first. A clip that uploads is removed whatever
 * the answer was; one that fails again stays for next time.
 *
 * Only one flush runs at a time: a second caller joins the one already going,
 * so a foreground event during a manual retry cannot upload everything twice.
 */
export function flushQueue(): Promise<FlushOutcome> {
  if (!inFlight) {
    inFlight = runFlush().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

export function isFlushing(): boolean {
  return inFlight !== null;
}

async function runFlush(): Promise<FlushOutcome> {
  const outcome: FlushOutcome = { identified: 0, failed: 0 };
  for (const item of [...queue].reverse()) {
    if (!fileExists(item.uri)) {
      await remove(item.id);
      continue;
    }
    let sessionId: string | null = null;
    try {
      sessionId = await createSession(item.source, item.hint);
      const result = await uploadClip(sessionId, item.uri, { clipKey: item.id });
      outcome.last = result;
      // The clip was analysed, so it is spent whatever the answer was.
      setLastResult({ result, source: item.source });
      if (result.identification && result.identification.kind !== "unknown") outcome.identified++;
      await remove(item.id);
    } catch (err) {
      outcome.failed++;
      if (err instanceof ApiError && isHopeless(err.status)) await remove(item.id);
    } finally {
      if (sessionId) void endSession(sessionId);
    }
  }
  return outcome;
}
