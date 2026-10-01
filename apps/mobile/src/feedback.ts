/**
 * The moments in src/feedback-gate.ts bound to the phone. This is the one
 * module that imports expo-haptics (the contract test pins that), and it has
 * no state and no branch of its own: every haptic goes through the gate, so
 * the Vibration setting cannot be bypassed from here.
 */
import * as Haptics from "expo-haptics";
import { createFeedback, type ImpactStyle, type NoticeKind } from "./feedback-gate";

const IMPACT: Record<ImpactStyle, Haptics.ImpactFeedbackStyle> = {
  light: Haptics.ImpactFeedbackStyle.Light,
  medium: Haptics.ImpactFeedbackStyle.Medium,
};

const NOTICE: Record<NoticeKind, Haptics.NotificationFeedbackType> = {
  success: Haptics.NotificationFeedbackType.Success,
  warning: Haptics.NotificationFeedbackType.Warning,
};

export const { setHapticsEnabled, captureStarted, recordingPicked, queued, identified, savedForLater } = createFeedback({
  impact: (style) => Haptics.impactAsync(IMPACT[style]),
  notification: (kind) => Haptics.notificationAsync(NOTICE[kind]),
});
