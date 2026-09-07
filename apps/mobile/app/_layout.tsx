import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { useColorScheme } from "react-native";
import { hydrate, useSettings } from "@/store";
import { useTheme } from "@/theme";

export default function RootLayout() {
  const c = useTheme();
  const { appearance } = useSettings();
  const system = useColorScheme();
  const dark = appearance === "system" ? system !== "light" : appearance === "dark";

  useEffect(() => {
    void hydrate();
  }, []);

  const theme = {
    ...DarkTheme,
    dark,
    colors: {
      ...DarkTheme.colors,
      primary: c.accent,
      background: c.bg,
      card: c.bg,
      text: c.text,
      border: c.border,
    },
  };

  return (
    <ThemeProvider value={theme}>
      <StatusBar style={dark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: c.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="result" options={{ title: "Result", presentation: "modal" }} />
        <Stack.Screen name="library" options={{ title: "Saved & recent" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
      </Stack>
    </ThemeProvider>
  );
}
