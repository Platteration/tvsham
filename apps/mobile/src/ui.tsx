import type { PropsWithChildren, ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { makeStyles, space, useTheme, type Palette } from "./theme";

type Variant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends Omit<PressableProps, "style" | "children"> {
  label: string;
  variant?: Variant;
  loading?: boolean;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}

function buttonColors(c: Palette, variant: Variant): { bg: string; fg: string } {
  switch (variant) {
    case "primary":
      return { bg: c.accent, fg: c.accentText };
    case "secondary":
      return { bg: c.surfaceAlt, fg: c.text };
    case "ghost":
      return { bg: "transparent", fg: c.muted };
    case "danger":
      return { bg: c.danger, fg: "#ffffff" };
  }
}

export function Button({ label, variant = "primary", loading, icon, style, compact, disabled, ...rest }: ButtonProps) {
  const c = useTheme();
  const styles = useStyles();
  const { bg, fg } = buttonColors(c, variant);
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: bg, opacity: pressed || disabled ? 0.7 : 1 },
        variant === "ghost" && { borderWidth: 1, borderColor: c.border },
        style,
      ]}
      {...rest}
    >
      {loading ? <ActivityIndicator color={fg} /> : icon}
      <Text style={[styles.buttonLabel, compact && styles.buttonLabelCompact, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const styles = useStyles();
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Chip({ label, color, textColor }: { label: string; color?: string; textColor?: string }) {
  const c = useTheme();
  const styles = useStyles();
  return (
    <View style={[styles.chip, { backgroundColor: color ?? c.surfaceAlt }]}>
      <Text style={[styles.chipText, { color: textColor ?? c.text }]}>{label}</Text>
    </View>
  );
}

type TextLike = PropsWithChildren<Omit<TextProps, "style"> & { style?: StyleProp<TextStyle> }>;

export function Title({ children, style, ...rest }: TextLike) {
  const styles = useStyles();
  return (
    <Text style={[styles.title, style]} {...rest}>
      {children}
    </Text>
  );
}

export function Muted({ children, style, ...rest }: TextLike) {
  const styles = useStyles();
  return (
    <Text style={[styles.muted, style]} {...rest}>
      {children}
    </Text>
  );
}

export function Body({ children, style, ...rest }: TextLike) {
  const styles = useStyles();
  return (
    <Text style={[styles.body, style]} {...rest}>
      {children}
    </Text>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.empty}>
      <Title style={{ textAlign: "center" }}>{title}</Title>
      {hint ? <Muted style={{ textAlign: "center", marginTop: space.sm }}>{hint}</Muted> : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    paddingVertical: 14,
    paddingHorizontal: space.lg,
    borderRadius: 14,
  },
  buttonCompact: { paddingVertical: 8, paddingHorizontal: space.md, borderRadius: 8 },
  buttonLabel: { fontSize: 16, fontWeight: "600" },
  buttonLabelCompact: { fontSize: 14 },
  card: {
    backgroundColor: c.surface,
    borderRadius: 22,
    padding: space.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
  },
  chip: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, alignSelf: "flex-start" },
  chipText: { fontSize: 12, fontWeight: "600", letterSpacing: 0.3 },
  title: { color: c.text, fontSize: 22, fontWeight: "700" },
  muted: { color: c.muted, fontSize: 14, lineHeight: 20 },
  body: { color: c.text, fontSize: 16, lineHeight: 22 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
}));
