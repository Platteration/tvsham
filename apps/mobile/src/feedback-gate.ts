/**
 * Haptic feedback behind the Vibration setting: the moments and the gate,
 * free of expo-haptics so they can be tested bare. Each function names a
 * moment in the app rather than a device effect, so a screen says what
 * happened and this module decides whether the phone answers. The gate is a
 * flag the store sets whenever the settings change, not a hook: a moment
 * fires from the first tap after hydration, before any screen has
 * re-rendered. src/feedback.ts binds the moments to expo-haptics; it is the
 * one module that imports it, and the contract test keeps it that way.
 */

export type ImpactStyle = "light" | "medium";
export type NoticeKind = "success" | "warning";

/** What the phone can do: expo-haptics on a device, a fake in a test. */
export interface HapticsDriver {
  impact(style: ImpactStyle): Promise<void>;
  notification(kind: NoticeKind): Promise<void>;
}

export interface Feedback {
  /** Set by the store; nothing here reads storage. On until it says otherwise. */
  setHapticsEnabled(on: boolean): void;
  /** The capture button was pressed and a clip is starting. */
  captureStarted(): void;
  /** A screen recording was picked and is on its way to the server. */
  recordingPicked(): void;
  /** The server could not be reached; the clip waits in the queue. */
  queued(): void;
  /** A result is in: a confident match, or only a guess. */
  identified(confident: boolean): void;
  /** Something was saved for later. */
  savedForLater(): void;
}

export function createFeedback(driver: HapticsDriver): Feedback {
  let enabled = true;
  /** Best-effort: a phone without a haptic engine rejects, which is nothing to surface. */
  const fire = (effect: () => Promise<void>): void => {
    if (!enabled) return;
    effect().catch(() => {});
  };
  return {
    setHapticsEnabled(on) {
      enabled = on;
    },
    captureStarted: () => fire(() => driver.impact("medium")),
    recordingPicked: () => fire(() => driver.impact("light")),
    queued: () => fire(() => driver.notification("warning")),
    identified: (confident) => fire(() => driver.notification(confident ? "success" : "warning")),
    savedForLater: () => fire(() => driver.notification("success")),
  };
}
