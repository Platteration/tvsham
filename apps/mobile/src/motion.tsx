import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { colors } from "./theme";

/**
 * Sonar rings that expand out of the capture button while a clip is being taken.
 * Three rings on a staggered loop; native-driven so the camera preview stays smooth.
 */
export function SonarRings({ size, active }: { size: number; active: boolean }) {
  const rings = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;

  useEffect(() => {
    if (!active) {
      for (const r of rings) r.setValue(0);
      return;
    }
    const loops = rings.map((value, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 600),
          Animated.timing(value, {
            toValue: 1,
            duration: 1800,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(value, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
      ),
    );
    for (const l of loops) l.start();
    return () => {
      for (const l of loops) l.stop();
    };
  }, [active, rings]);

  if (!active) return null;

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
      {rings.map((value, i) => (
        <Animated.View
          key={i}
          style={[
            {
              position: "absolute",
              width: size,
              height: size,
              borderRadius: size / 2,
              borderWidth: 2,
              borderColor: colors.accent,
            },
            {
              opacity: value.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.5, 0] }),
              transform: [{ scale: value.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] }) }],
            },
          ]}
        />
      ))}
    </View>
  );
}

/** A slow breathing scale, used on the capture button so it never looks frozen. */
export function Breathing({ active, children, style }: { active: boolean; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      value.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(value, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, value]);
  return (
    <Animated.View style={[style, { transform: [{ scale: value.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) }] }]}>
      {children}
    </Animated.View>
  );
}

/**
 * Confidence as a ring rather than a bare percentage: it reads at a glance and
 * doesn't invite an argument about whether 62% is good.
 */
export function ConfidenceRing({
  value,
  size = 44,
  stroke = 4,
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const clamped = Math.max(0, Math.min(1, value));
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const colour = clamped >= 0.7 ? colors.success : clamped >= 0.35 ? colors.warning : colors.danger;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.border} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colour}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circumference * clamped} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      {children}
    </View>
  );
}

/** Corner brackets that frame the screen the user should be pointing at. */
export function ViewfinderFrame() {
  const corners: Array<StyleProp<ViewStyle>> = [
    { top: 0, left: 0, borderLeftWidth: 3, borderTopWidth: 3, borderTopLeftRadius: 12 },
    { top: 0, right: 0, borderRightWidth: 3, borderTopWidth: 3, borderTopRightRadius: 12 },
    { bottom: 0, left: 0, borderLeftWidth: 3, borderBottomWidth: 3, borderBottomLeftRadius: 12 },
    { bottom: 0, right: 0, borderRightWidth: 3, borderBottomWidth: 3, borderBottomRightRadius: 12 },
  ];
  return (
    <View pointerEvents="none" style={styles.viewfinder}>
      {corners.map((c, i) => (
        <View key={i} style={[styles.corner, c]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  viewfinder: { position: "absolute", top: "16%", left: "6%", right: "6%", bottom: "30%" },
  corner: { position: "absolute", width: 34, height: 34, borderColor: "rgba(255,255,255,0.75)" },
});
