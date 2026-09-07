import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { HealthResponse } from "@tvsham/shared";
import { health } from "@/api";
import { updateSettings, useSettings } from "@/store";
import { ACCENTS, ACCENT_NAMES, makeStyles, radius, space, useTheme, type AccentName, type Appearance } from "@/theme";
import { Button, Card, Muted, Title } from "@/ui";

export default function SettingsScreen() {
  const styles = useStyles();
  const c = useTheme();
  const settings = useSettings();
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [token, setToken] = useState(settings.token);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    await updateSettings({ serverUrl: serverUrl.trim(), token: token.trim() });
  };

  const test = async () => {
    setTesting(true);
    setStatus(null);
    try {
      await save();
      const h: HealthResponse = await health();
      setStatus({
        ok: true,
        text: `Connected · v${h.version} · model ${h.model} · ffmpeg ${h.ffmpeg ? "ok" : "missing"} · speech-to-text ${h.stt}`,
      });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : "Could not reach the server." });
    } finally {
      setTesting(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Card>
          <Title>Recognition server</Title>
          <Muted style={{ marginTop: space.xs }}>
            The app sends short clips to your own TVsham server, which runs the recognition and looks up Wikipedia and YouTube. See the README for how to run one.
          </Muted>
          <Text style={styles.label}>Server URL</Text>
          <TextInput
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="http://192.168.1.20:8787"
            placeholderTextColor={c.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.input}
            onBlur={() => void save()}
          />
          <Text style={styles.label}>Access token (optional)</Text>
          <TextInput
            value={token}
            onChangeText={setToken}
            placeholder="Matches APP_TOKEN on the server"
            placeholderTextColor={c.muted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={styles.input}
            onBlur={() => void save()}
          />
          <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.lg }}>
            <Button label="Save" variant="secondary" onPress={() => void save()} style={{ flex: 1 }} />
            <Button label="Test connection" loading={testing} onPress={() => void test()} style={{ flex: 1 }} />
          </View>
          {status ? (
            <Text style={[styles.status, { color: status.ok ? c.success : c.danger }]}>{status.text}</Text>
          ) : null}
        </Card>

        <Card>
          <Title>Appearance</Title>
          <Muted style={{ marginTop: space.xs }}>
            Follow the system, or pin one. The camera screen stays dark either way.
          </Muted>
          <View style={styles.segment}>
            {(["system", "light", "dark"] as Appearance[]).map((a) => (
              <Pressable
                key={a}
                onPress={() => void updateSettings({ appearance: a })}
                style={[styles.segmentTab, settings.appearance === a && styles.segmentTabActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: settings.appearance === a }}
              >
                <Text style={[styles.segmentText, settings.appearance === a && styles.segmentTextActive]}>
                  {a === "system" ? "System" : a === "light" ? "Light" : "Dark"}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.label}>Accent</Text>
          <View style={styles.swatchRow}>
            {ACCENT_NAMES.map((name: AccentName) => {
              const owned = settings.unlockedAccents.includes(name);
              const selected = settings.accent === name;
              return (
                <Pressable
                  key={name}
                  disabled={!owned}
                  onPress={() => void updateSettings({ accent: name })}
                  style={[styles.swatch, selected && { borderColor: c.text }, !owned && { opacity: 0.4 }]}
                  accessibilityRole="button"
                  accessibilityLabel={ACCENTS[name].label}
                  accessibilityState={{ selected }}
                >
                  <View style={[styles.swatchDot, { backgroundColor: ACCENTS[name].accent }]} />
                  <Muted style={{ fontSize: 12 }}>{ACCENTS[name].label}</Muted>
                </Pressable>
              );
            })}
          </View>
        </Card>

        <Card>
          <Title>How it works</Title>
          <Muted style={{ marginTop: space.xs }}>
            Each clip is a few seconds of video. The server pulls out a handful of frames and (if configured) a transcript of the dialogue, asks Claude to identify the show, film or video with web search to verify, then fetches the matching Wikipedia article or YouTube link. Clips are deleted as soon as they have been analysed.
          </Muted>
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const useStyles = makeStyles((c) => ({
  container: { padding: space.lg, gap: space.lg },
  label: { color: c.muted, fontSize: 13, fontWeight: "600", marginTop: space.lg, marginBottom: space.xs },
  input: {
    backgroundColor: c.surfaceAlt,
    color: c.text,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    fontSize: 16,
    borderWidth: 1,
    borderColor: c.border,
  },
  status: { marginTop: space.md, fontSize: 13, lineHeight: 18 },
  segment: {
    flexDirection: "row",
    marginTop: space.md,
    backgroundColor: c.surfaceAlt,
    borderRadius: radius.pill,
    padding: 4,
  },
  segmentTab: { flex: 1, paddingVertical: 8, borderRadius: radius.pill, alignItems: "center" },
  segmentTabActive: { backgroundColor: c.surface },
  segmentText: { color: c.muted, fontWeight: "600", fontSize: 14 },
  segmentTextActive: { color: c.text },
  swatchRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  swatch: {
    alignItems: "center",
    gap: 6,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: c.border,
    minWidth: 84,
  },
  swatchDot: { width: 26, height: 26, borderRadius: 13 },
}));
