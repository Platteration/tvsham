import { Alert, Platform } from "react-native";

/**
 * A two-button confirmation: cancel is the safe default, the destructive
 * button is named with its verb. react-native-web implements Alert as an
 * empty stub, so a confirmation there does nothing at all and the button it
 * guards looks broken. The browser's own dialog stands in on that platform.
 *
 * The rule for when to ask: an action is confirmed if and only if it destroys
 * what the app cannot restore from inside itself.
 */
export function confirmAction({
  title,
  message,
  cancelLabel,
  confirmLabel,
  onConfirm,
}: {
  title: string;
  message: string;
  cancelLabel: string;
  confirmLabel: string;
  onConfirm: () => void;
}): void {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: cancelLabel, style: "cancel" },
    { text: confirmLabel, style: "destructive", onPress: onConfirm },
  ]);
}
