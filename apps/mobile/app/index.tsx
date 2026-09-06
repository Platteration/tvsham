import { CameraView, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { useKeepAwake } from "expo-keep-awake";
import { Link, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CLIP_SECONDS, MAX_CLIPS_PER_SESSION, type CaptureSource } from "@tvsham/shared";
import { colors, radius, space } from "@/theme";
import { Button, Card, Muted, Title } from "@/ui";
import { useIdentify, type ClipProducer } from "@/useIdentify";
import { useHydrated, useSettings } from "@/store";

type Mode = CaptureSource;

export default function CaptureScreen() {
  const [mode, setMode] = useState<Mode>("camera");
  const router = useRouter();
  const { state, start, cancel, reset } = useIdentify();
  const settings = useSettings();
  const hydrated = useHydrated();
  const insets = useSafeAreaInsets();
  const busy = state.phase === "recording" || state.phase === "uploading";

  useEffect(() => {
    if (state.phase === "done" && state.result) {
      void Haptics.notificationAsync(
        state.result.status === "identified"
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning,
      );
      router.push("/result");
      reset();
    }
  }, [state.phase, state.result, router, reset]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <Text style={styles.brand}>TVsham</Text>
        <View style={styles.topActions}>
          <Link href="/library" asChild>
            <Pressable hitSlop={12} accessibilityLabel="Saved for later">
              <Text style={styles.topLink}>Saved</Text>
            </Pressable>
          </Link>
          <Link href="/settings" asChild>
            <Pressable hitSlop={12} accessibilityLabel="Settings">
              <Text style={styles.topLink}>Settings</Text>
            </Pressable>
          </Link>
        </View>
      </View>

      <View style={styles.modeSwitch}>
        {(["camera", "screen"] as const).map((m) => (
          <Pressable
            key={m}
            disabled={busy}
            onPress={() => setMode(m)}
            style={[styles.modeTab, mode === m && styles.modeTabActive]}
          >
            <Text style={[styles.modeTabText, mode === m && styles.modeTabTextActive]}>
              {m === "camera" ? "Point at a TV" : "My screen"}
            </Text>
          </Pressable>
        ))}
      </View>

      {hydrated && !settings.serverUrl ? (
        <Card style={styles.notice}>
          <Title>Connect a server</Title>
          <Muted style={{ marginTop: space.sm }}>
            TVsham needs its recognition server to identify video. Add the URL in Settings.
          </Muted>
          <Button label="Open Settings" variant="secondary" style={{ marginTop: space.md }} onPress={() => router.push("/settings")} />
        </Card>
      ) : mode === "camera" ? (
        <CameraMode state={state} start={start} cancel={cancel} />
      ) : (
        <ScreenMode state={state} start={start} cancel={cancel} />
      )}

      {state.phase === "error" ? (
        <Card style={[styles.notice, { borderColor: colors.danger }]}>
          <Text style={{ color: colors.danger, fontWeight: "700" }}>Couldn't identify</Text>
          <Muted style={{ marginTop: space.xs }}>{state.error}</Muted>
          <Button label="Dismiss" variant="ghost" compact style={{ marginTop: space.md, alignSelf: "flex-start" }} onPress={reset} />
        </Card>
      ) : null}
    </View>
  );
}

type ModeProps = Pick<ReturnType<typeof useIdentify>, "state" | "start" | "cancel">;

function CameraMode({ state, start, cancel }: ModeProps) {
  const [camPerm, requestCam] = useCameraPermissions();
  const [micPerm, requestMic] = useMicrophonePermissions();
  const cameraRef = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const busy = state.phase === "recording" || state.phase === "uploading";
  useKeepAwake();

  const granted = camPerm?.granted && micPerm?.granted;

  const requestAll = useCallback(async () => {
    if (!camPerm?.granted) await requestCam();
    if (!micPerm?.granted) await requestMic();
  }, [camPerm?.granted, micPerm?.granted, requestCam, requestMic]);

  const producer: ClipProducer = {
    async record() {
      const cam = cameraRef.current;
      if (!cam) return null;
      // iOS only honours `videoQuality` when a codec is given explicitly.
      const out = await cam.recordAsync({
        maxDuration: CLIP_SECONDS,
        ...(Platform.OS === "ios" ? { codec: "avc1" as const } : {}),
      });
      return out?.uri ?? null;
    },
    stop() {
      cameraRef.current?.stopRecording();
    },
  };

  const onPress = () => {
    if (busy) {
      cancel();
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void start("camera", producer);
  };

  if (!camPerm || !micPerm) return <ActivityIndicator style={{ marginTop: space.xl }} color={colors.accent} />;

  if (!granted) {
    return (
      <Card style={styles.notice}>
        <Title>Camera and microphone</Title>
        <Muted style={{ marginTop: space.sm }}>
          Point your phone at the TV. The camera reads what's on screen and the microphone picks up dialogue. Nothing is stored after it's identified.
        </Muted>
        <Button label="Allow access" style={{ marginTop: space.md }} onPress={() => void requestAll()} />
      </Card>
    );
  }

  return (
    <View style={styles.cameraWrap}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        mode="video"
        videoQuality="480p"
        onCameraReady={() => setReady(true)}
      />
      <View style={styles.cameraOverlay} pointerEvents="box-none">
        <StatusPill state={state} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={busy ? "Stop listening" : "Identify"}
          disabled={!ready}
          onPress={onPress}
          style={({ pressed }) => [styles.bigButton, busy && styles.bigButtonBusy, pressed && { transform: [{ scale: 0.96 }] }]}
        >
          {busy ? <View style={styles.stopSquare} /> : <Text style={styles.bigButtonText}>Identify</Text>}
        </Pressable>
        <Muted style={styles.hint}>
          {busy ? "Tap to stop" : "Frame the screen and hold steady. Dialogue and on-screen text help."}
        </Muted>
      </View>
    </View>
  );
}

function ScreenMode({ state, start, cancel }: ModeProps) {
  const busy = state.phase === "recording" || state.phase === "uploading";

  const pick = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["videos"],
      allowsMultipleSelection: false,
      quality: 0.6,
    });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const producer: ClipProducer = {
      record: async () => asset.uri,
    };
    // A screen recording is analysed in one go; the server looks at up to a minute of it.
    void start("screen", producer, { maxClips: 1 });
  };

  return (
    <View style={{ padding: space.lg, gap: space.md }}>
      <Card>
        <Title>Record your screen, then pick it</Title>
        <Muted style={{ marginTop: space.sm }}>
          {Platform.OS === "ios"
            ? "1. Open Control Center and tap Screen Record.\n2. Watch the video for 10–20 seconds.\n3. Stop the recording and come back here."
            : "1. Swipe down to Quick Settings and tap Screen record (with sound on).\n2. Watch the video for 10–20 seconds.\n3. Stop the recording and come back here."}
        </Muted>
        <Muted style={{ marginTop: space.sm }}>
          Works with YouTube, Shorts, TikTok, Reels, Netflix and anything else playing on your phone. Titles, captions and channel names in the recording make it much more accurate.
        </Muted>
      </Card>
      <StatusPill state={state} />
      {busy ? (
        <Button label="Cancel" variant="secondary" onPress={cancel} />
      ) : (
        <Button label="Choose a screen recording" onPress={() => void pick()} />
      )}
    </View>
  );
}

function StatusPill({ state }: { state: ReturnType<typeof useIdentify>["state"] }) {
  if (state.phase !== "recording" && state.phase !== "uploading") return <View style={styles.pillSpacer} />;
  const guess = state.result?.identification;
  const label =
    state.phase === "recording"
      ? `Listening… clip ${state.clip} of ${MAX_CLIPS_PER_SESSION}`
      : guess && guess.confidence > 0.3
        ? `Checking… could be ${guess.title}`
        : "Identifying…";
  return (
    <View style={styles.pill}>
      <ActivityIndicator color={colors.text} size="small" />
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  brand: { color: colors.text, fontSize: 24, fontWeight: "800", letterSpacing: -0.5 },
  topActions: { flexDirection: "row", gap: space.lg },
  topLink: { color: colors.accent, fontSize: 16, fontWeight: "600" },
  modeSwitch: {
    flexDirection: "row",
    marginHorizontal: space.lg,
    marginBottom: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    padding: 4,
  },
  modeTab: { flex: 1, paddingVertical: 10, borderRadius: radius.pill, alignItems: "center" },
  modeTabActive: { backgroundColor: colors.surfaceAlt },
  modeTabText: { color: colors.muted, fontWeight: "600" },
  modeTabTextActive: { color: colors.text },
  notice: { marginHorizontal: space.lg, marginBottom: space.md },
  cameraWrap: {
    flex: 1,
    marginHorizontal: space.lg,
    marginBottom: space.lg,
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  cameraOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "flex-end",
    alignItems: "center",
    padding: space.lg,
    gap: space.md,
  },
  bigButton: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 6,
    borderColor: "rgba(255,255,255,0.25)",
  },
  bigButtonBusy: { backgroundColor: colors.danger },
  bigButtonText: { color: colors.accentText, fontSize: 18, fontWeight: "800" },
  stopSquare: { width: 34, height: 34, borderRadius: 6, backgroundColor: colors.accentText },
  hint: { textAlign: "center", color: "rgba(255,255,255,0.8)" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
  },
  pillSpacer: { height: 36 },
  pillText: { color: colors.text, fontWeight: "600" },
});
