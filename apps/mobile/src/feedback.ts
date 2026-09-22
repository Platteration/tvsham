/**
 * Haptic feedback, behind the Vibration setting. Each function names a moment
 * in the app rather than a device effect, so a screen says what happened and
 * this module decides whether the phone answers. The gate is a module flag
 * the store sets whenever the settings change, not a hook: a moment fires
 * from the first tap after hydration, before any screen has re-rendered.
 * Free of React Native itself; expo-haptics is the only import.
 */
import * as Haptics from "expo-haptics";

let enabled = true;

/** Set by the store; nothing here reads storage. */
export function setHapticsEnabled(on: boolean): void {
  enabled = on;
}

/** Best-effort: a phone without a haptic engine rejects, which is nothing to surface. */
function fire(fn: () => Promise<void>): void {
  if (!enabled) return;
  fn().catch(() => {});
}

/** The capture button was pressed and a clip is starting. */
export function captureStarted(): void {
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
}

/** A screen recording was picked and is on its way to the server. */
export function recordingPicked(): void {
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** The server could not be reached; the clip waits in the queue. */
export function queued(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}

/** A result is in: a confident match, or only a guess. */
export function identified(confident: boolean): void {
  fire(() =>
    Haptics.notificationAsync(
      confident ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
    ),
  );
}

/** Something was saved for later. */
export function savedForLater(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}
