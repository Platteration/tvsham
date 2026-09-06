import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { hydrate } from "@/store";
import { colors } from "@/theme";

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.accent,
    background: colors.bg,
    card: colors.bg,
    text: colors.text,
    border: colors.border,
  },
};

export default function RootLayout() {
  useEffect(() => {
    void hydrate();
  }, []);

  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
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
