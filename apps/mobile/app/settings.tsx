import Constants from "expo-constants";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import type { HealthResponse } from "@tvsham/shared";
import { health } from "@/api";
import { confirmAction } from "@/confirm";
import { isSafeWebUrl } from "@/format";
import { APPEARANCE_NAMES, REDUCE_MOTION_NAMES, serverUrlWarning, type ReduceMotion } from "@/settings";
import { resetSettings, updateSettings, useSettings } from "@/store";
import { ACCENTS, ACCENT_NAMES, makeStyles, radius, space, useTheme, type AccentName, type Appearance } from "@/theme";
import { Button, Card, Muted, Title } from "@/ui";

/** Where the code lives. Opened through the same gate every other link passes. */
const SOURCE_URL = "https://github.com/Platteration/tvsham";

// Typed against the enums, so a value the validator keeps cannot be one the
// control does not offer.
const APPEARANCE_LABELS: Record<Appearance, string> = { system: "System", light: "Light", dark: "Dark" };
const REDUCE_MOTION_LABELS: Record<ReduceMotion, string> = { system: "System", on: "On", off: "Off" };

export default function SettingsScreen() {
  const styles = useStyles();
  const c = useTheme();
  const settings = useSettings();
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [token, setToken] = useState(settings.token);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  // Saving drops a URL it cannot use, so say so while the user can still fix it.
  const urlWarning = serverUrlWarning(serverUrl);
  const version = Constants.expoConfig?.version ?? "0.0.0";

  const save = async () => {
    await updateSettings({ serverUrl: serverUrl.trim(), token: token.trim() });
  };

  const test = async () => {
    setTesting(true);
    setStatus(null);
    try {
      await save();
      const h: HealthResponse = await health();
      const parts = [
        `Connected · v${h.version}`,
        `model ${h.model}`,
        h.firstPassModel ? `first pass ${h.firstPassModel}` : null,
        `ffmpeg ${h.ffmpeg ? "ok" : "missing"}`,
        `speech-to-text ${h.stt}`,
        h.tmdb ? "where to watch on" : "where to watch off",
        h.dailyClipLimit > 0 ? `${h.dailyClipLimit} clips/day` : null,
      ].filter(Boolean);
      setStatus({ ok: true, text: parts.join(" · ") });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : "Could not reach the server." });
    } finally {
      setTesting(false);
    }
  };

  const reset = () =>
    confirmAction({
      title: "Reset settings?",
      message:
        "This puts every preference back to its default. Your library, history, server address, access token and the accents you own are not affected.",
      cancelLabel: "Cancel",
      confirmLabel: "Reset",
      onConfirm: () => void resetSettings(),
    });

  const openSource = () => {
    if (isSafeWebUrl(SOURCE_URL)) void WebBrowser.openBrowserAsync(SOURCE_URL);
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
          {urlWarning ? <Text style={[styles.status, { color: c.warning }]}>{urlWarning}</Text> : null}
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
          <Segmented
            options={APPEARANCE_NAMES.map((a) => ({ value: a, label: APPEARANCE_LABELS[a] }))}
            value={settings.appearance}
            onChange={(a) => void updateSettings({ appearance: a })}
          />

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
                  accessibilityState={{ selected, disabled: !owned }}
                >
                  <View style={[styles.swatchDot, { backgroundColor: ACCENTS[name].accent }]} />
                  <Muted style={{ fontSize: 12 }}>{ACCENTS[name].label}</Muted>
                </Pressable>
              );
            })}
          </View>
        </Card>

        <Card>
          <Title>Feedback and motion</Title>
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>Vibration</Text>
              <Muted style={{ marginTop: 2 }}>
                A short buzz when a clip starts, when a result is in and when something is saved.
              </Muted>
            </View>
            <Switch
              value={settings.haptics}
              onValueChange={(on) => void updateSettings({ haptics: on })}
              trackColor={{ true: c.accent, false: c.border }}
              accessibilityLabel="Vibration"
            />
          </View>

          <Text style={styles.label}>Reduce motion</Text>
          <Muted>
            Stills the sonar rings and the breathing capture button. System follows the phone’s own accessibility setting.
          </Muted>
          <Segmented
            options={REDUCE_MOTION_NAMES.map((m) => ({ value: m, label: REDUCE_MOTION_LABELS[m] }))}
            value={settings.reduceMotion}
            onChange={(m) => void updateSettings({ reduceMotion: m })}
          />

          <Text style={styles.label}>Reset</Text>
          <Muted>
            Puts appearance, accent, vibration and reduced motion back to how the app shipped. The server address, the access token and the accents you own are connection settings and purchases, not preferences, and stay as they are.
          </Muted>
          <Button label="Reset to defaults" variant="ghost" compact style={styles.resetButton} onPress={reset} />
        </Card>

        <Card>
          <Title>How it works</Title>
          <Muted style={{ marginTop: space.xs }}>TVsham {version} · Shazam, but for video.</Muted>
          <Muted style={{ marginTop: space.sm }}>
            Each clip is a few seconds of video. The server pulls out a handful of frames and (if configured) a transcript of the dialogue, asks Claude to identify the show, film or video with web search to verify, then fetches the matching Wikipedia article or YouTube link.
          </Muted>
          <Muted style={{ marginTop: space.sm }}>
            Everything the app sends — each clip, your optional hint, the access token and a random per-install id — goes only to the server address you set above, and the server deletes a clip as soon as it has been analysed.
          </Muted>
          <Pressable
            onPress={openSource}
            hitSlop={8}
            style={styles.linkRow}
            accessibilityRole="link"
            accessibilityLabel="MIT licence and source code"
          >
            <Text style={styles.link}>MIT licence · source</Text>
          </Pressable>
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * One control for every three-way choice, so Appearance and Reduce motion
 * share a shape. Each option is a button carrying its selected state.
 */
function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.segment}>
      {options.map((o) => {
        const selected = value === o.value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={[styles.segmentTab, selected && styles.segmentTabActive]}
            accessibilityRole="button"
            accessibilityState={{ selected }}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  container: { padding: space.lg, gap: space.lg },
  label: { color: c.muted, fontSize: 13, fontWeight: "600", marginTop: space.lg, marginBottom: space.xs },
  rowLabel: { color: c.text, fontSize: 16, fontWeight: "600" },
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
  switchRow: { flexDirection: "row", alignItems: "center", gap: space.md, marginTop: space.md },
  resetButton: { marginTop: space.md, alignSelf: "flex-start" },
  linkRow: { alignSelf: "flex-start", marginTop: space.md },
  link: { color: c.accent, fontSize: 14, fontWeight: "600" },
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
