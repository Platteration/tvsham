import type { PropsWithChildren, ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type TextProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { colors, radius, space } from "./theme";

type Variant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends Omit<PressableProps, "style" | "children"> {
  label: string;
  variant?: Variant;
  loading?: boolean;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}

export function Button({ label, variant = "primary", loading, icon, style, compact, disabled, ...rest }: ButtonProps) {
  const bg: Record<Variant, string> = {
    primary: colors.accent,
    secondary: colors.surfaceAlt,
    ghost: "transparent",
    danger: colors.danger,
  };
  const fg: Record<Variant, string> = {
    primary: colors.accentText,
    secondary: colors.text,
    ghost: colors.muted,
    danger: colors.accentText,
  };
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: bg[variant], opacity: pressed || disabled ? 0.7 : 1 },
        variant === "ghost" && { borderWidth: 1, borderColor: colors.border },
        style,
      ]}
      {...rest}
    >
      {loading ? <ActivityIndicator color={fg[variant]} /> : icon}
      <Text style={[styles.buttonLabel, compact && styles.buttonLabelCompact, { color: fg[variant] }]}>{label}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Chip({ label, color = colors.surfaceAlt, textColor = colors.text }: { label: string; color?: string; textColor?: string }) {
  return (
    <View style={[styles.chip, { backgroundColor: color }]}>
      <Text style={[styles.chipText, { color: textColor }]}>{label}</Text>
    </View>
  );
}

type TextLike = PropsWithChildren<Omit<TextProps, "style"> & { style?: StyleProp<TextStyle> }>;

export function Title({ children, style, ...rest }: TextLike) {
  return (
    <Text style={[styles.title, style]} {...rest}>
      {children}
    </Text>
  );
}

export function Muted({ children, style, ...rest }: TextLike) {
  return (
    <Text style={[styles.muted, style]} {...rest}>
      {children}
    </Text>
  );
}

export function Body({ children, style, ...rest }: TextLike) {
  return (
    <Text style={[styles.body, style]} {...rest}>
      {children}
    </Text>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={styles.empty}>
      <Title style={{ textAlign: "center" }}>{title}</Title>
      {hint ? <Muted style={{ textAlign: "center", marginTop: space.sm }}>{hint}</Muted> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    paddingVertical: 14,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
  },
  buttonCompact: { paddingVertical: 8, paddingHorizontal: space.md, borderRadius: radius.sm },
  buttonLabel: { fontSize: 16, fontWeight: "600" },
  buttonLabelCompact: { fontSize: 14 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  chip: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: radius.pill, alignSelf: "flex-start" },
  chipText: { fontSize: 12, fontWeight: "600", letterSpacing: 0.3 },
  title: { color: colors.text, fontSize: 22, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  body: { color: colors.text, fontSize: 16, lineHeight: 22 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
});
