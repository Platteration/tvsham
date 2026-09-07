import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import { useSyncExternalStore } from "react";
import type { RecognitionResult, SavedItem, CaptureSource } from "@tvsham/shared";
import { DEFAULT_SETTINGS, sanitise, type Settings } from "./settings";

/* ----------------------------- tiny store core ---------------------------- */

type Listener = () => void;

function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(next: T | ((prev: T) => T)) {
      state = typeof next === "function" ? (next as (prev: T) => T)(state) : next;
      for (const l of listeners) l();
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/* --------------------------------- settings -------------------------------- */



const SETTINGS_KEY = "tvsham.settings.v1";
const LIBRARY_KEY = "tvsham.library.v1";
const HISTORY_KEY = "tvsham.history.v1";
const DEVICE_KEY = "tvsham.device.v1";
/** How many recent identifications to keep around. */
const HISTORY_LIMIT = 30;

/** In development, guess the server is on the same machine as the Metro bundler. */
function defaultServerUrl(): string {
  const configured = (Constants.expoConfig?.extra as { serverUrl?: string } | undefined)?.serverUrl;
  if (configured) return configured;
  const host = Constants.expoConfig?.hostUri?.split(":")[0];
  return host ? `http://${host}:8787` : "";
}

const settingsStore = createStore<Settings>({ ...DEFAULT_SETTINGS, serverUrl: defaultServerUrl() });
const libraryStore = createStore<SavedItem[]>([]);
const historyStore = createStore<SavedItem[]>([]);
const hydrated = createStore<boolean>(false);

/** The most recent result, handed from the capture screen to the result screen. */
export interface LastResult {
  result: RecognitionResult;
  source: CaptureSource;
}
const lastResultStore = createStore<LastResult | null>(null);

/**
 * A random per-install id sent with uploads so a server with a daily cap can
 * count per device. It identifies the install, nothing about the person.
 */
let deviceId = "";

export function getDeviceId(): string {
  return deviceId;
}

function newDeviceId(): string {
  const bytes = Crypto.getRandomBytes(16);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

let hydrating: Promise<void> | null = null;

export function hydrate(): Promise<void> {
  if (hydrating) return hydrating;
  hydrating = (async () => {
    try {
      const [s, l, h, d] = await AsyncStorage.multiGet([SETTINGS_KEY, LIBRARY_KEY, HISTORY_KEY, DEVICE_KEY]);
      deviceId = d?.[1] ?? "";
      if (!deviceId) {
        deviceId = newDeviceId();
        await AsyncStorage.setItem(DEVICE_KEY, deviceId);
      }
      const savedSettings = s?.[1] ? (JSON.parse(s[1]) as Partial<Settings>) : null;
      if (savedSettings) settingsStore.set((prev) => sanitise({ ...prev, ...savedSettings }));
      const savedLibrary = l?.[1] ? (JSON.parse(l[1]) as SavedItem[]) : null;
      if (Array.isArray(savedLibrary)) libraryStore.set(savedLibrary);
      const savedHistory = h?.[1] ? (JSON.parse(h[1]) as SavedItem[]) : null;
      if (Array.isArray(savedHistory)) historyStore.set(savedHistory);
    } catch (err) {
      console.warn("[store] failed to hydrate", err);
    } finally {
      hydrated.set(true);
    }
  })();
  return hydrating;
}

export type { Settings } from "./settings";

export const getSettings = settingsStore.get;

export function useSettings(): Settings {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get);
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  settingsStore.set((prev) => sanitise({ ...prev, ...patch }));
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsStore.get()));
}

export function useHydrated(): boolean {
  return useSyncExternalStore(hydrated.subscribe, hydrated.get, hydrated.get);
}

/* --------------------------------- library --------------------------------- */

export function useLibrary(): SavedItem[] {
  return useSyncExternalStore(libraryStore.subscribe, libraryStore.get, libraryStore.get);
}

async function persistLibrary(): Promise<void> {
  await AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(libraryStore.get()));
}

export function isSaved(result: RecognitionResult): boolean {
  return libraryStore.get().some((i) => i.id === result.sessionId);
}

function toSavedItem(result: RecognitionResult, source: CaptureSource): SavedItem | null {
  if (!result.identification) return null;
  return {
    id: result.sessionId,
    savedAt: new Date().toISOString(),
    source,
    identification: result.identification,
    links: result.links,
    watched: false,
  };
}

export async function saveResult(result: RecognitionResult, source: CaptureSource): Promise<SavedItem | null> {
  const item = toSavedItem(result, source);
  if (!item) return null;
  libraryStore.set((prev) => [item, ...prev.filter((i) => i.id !== item.id)]);
  await persistLibrary();
  return item;
}

export async function removeSaved(id: string): Promise<void> {
  libraryStore.set((prev) => prev.filter((i) => i.id !== id));
  await persistLibrary();
}

export async function setWatched(id: string, watched: boolean): Promise<void> {
  libraryStore.set((prev) => prev.map((i) => (i.id === id ? { ...i, watched } : i)));
  await persistLibrary();
}

/* --------------------------------- history --------------------------------- */

export function useHistory(): SavedItem[] {
  return useSyncExternalStore(historyStore.subscribe, historyStore.get, historyStore.get);
}

/** Every identification is remembered here (whether saved or not) so nothing is lost. */
async function recordHistory(result: RecognitionResult, source: CaptureSource): Promise<void> {
  const item = toSavedItem(result, source);
  if (!item || item.identification.kind === "unknown") return;
  historyStore.set((prev) => [item, ...prev.filter((i) => i.id !== item.id)].slice(0, HISTORY_LIMIT));
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(historyStore.get()));
}

export async function clearHistory(): Promise<void> {
  historyStore.set([]);
  await AsyncStorage.removeItem(HISTORY_KEY);
}

/** Promote a history entry to the saved library. */
export async function saveHistoryItem(item: SavedItem): Promise<void> {
  libraryStore.set((prev) => [{ ...item, savedAt: new Date().toISOString() }, ...prev.filter((i) => i.id !== item.id)]);
  await persistLibrary();
}

/* ------------------------------- last result ------------------------------- */

export function setLastResult(next: LastResult | null): void {
  lastResultStore.set(next);
  if (next) void recordHistory(next.result, next.source);
}

export function useLastResult(): LastResult | null {
  return useSyncExternalStore(lastResultStore.subscribe, lastResultStore.get, lastResultStore.get);
}
