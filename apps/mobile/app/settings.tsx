import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { HealthResponse } from "@tvsham/shared";
import { health } from "@/api";
import { updateSettings, useSettings } from "@/store";
import { colors, radius, space } from "@/theme";
import { Button, Card, Muted, Title } from "@/ui";

export default function SettingsScreen() {
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
            placeholderTextColor={colors.muted}
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
            placeholderTextColor={colors.muted}
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
            <Text style={[styles.status, { color: status.ok ? colors.success : colors.danger }]}>{status.text}</Text>
          ) : null}
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

const styles = StyleSheet.create({
  container: { padding: space.lg, gap: space.lg },
  label: { color: colors.muted, fontSize: 13, fontWeight: "600", marginTop: space.lg, marginBottom: space.xs },
  input: {
    backgroundColor: colors.surfaceAlt,
    color: colors.text,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    fontSize: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  status: { marginTop: space.md, fontSize: 13, lineHeight: 18 },
});
