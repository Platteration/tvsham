import { CameraView, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { useKeepAwake } from "expo-keep-awake";
import { Link, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CLIP_SECONDS, MAX_CLIPS_PER_SESSION, MAX_HINT_LENGTH, type CaptureSource } from "@tvsham/shared";
import { Breathing, SonarRings, ViewfinderFrame } from "@/motion";
import { makeStyles, radius, space, useTheme } from "@/theme";
import { Button, Card, Muted, Title } from "@/ui";
import { useIdentify, type ClipProducer } from "@/useIdentify";
import { clearQueue, flushQueue, isFlushing, loadQueue, queueLength, useQueue } from "@/queue";
import { useHydrated, useSettings } from "@/store";

type Mode = CaptureSource;

export default function CaptureScreen() {
  const styles = useStyles();
  const c = useTheme();
  const [mode, setMode] = useState<Mode>("camera");
  const [hint, setHint] = useState("");
  const pending = useQueue();
  const [flushing, setFlushing] = useState(false);
  const router = useRouter();
  const { state, start, cancel, reset } = useIdentify();
  const settings = useSettings();
  const hydrated = useHydrated();
  const insets = useSafeAreaInsets();
  const busy = state.phase === "recording" || state.phase === "uploading";

  useEffect(() => {
    void loadQueue();
  }, []);

  const flush = useCallback(async () => {
    setFlushing(true);
    try {
      const outcome = await flushQueue();
      // Show the answer even when it is "couldn't identify", so a clip never
      // disappears from the queue without the user learning what happened.
      if (outcome.last?.identification) router.push("/result");
    } finally {
      setFlushing(false);
    }
  }, [router]);

  // Retry queued clips whenever the app comes back, which is usually when a
  // connection has come back too.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && queueLength() > 0 && !busy && !isFlushing()) void flush();
    });
    return () => sub.remove();
  }, [busy, flush]);

  useEffect(() => {
    if (state.phase === "queued") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      reset();
    }
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
      ) : (
        <>
          <HintField value={hint} onChange={setHint} disabled={busy} />
          {mode === "camera" ? (
            <CameraMode state={state} start={start} cancel={cancel} hint={hint} />
          ) : (
            <ScreenMode state={state} start={start} cancel={cancel} hint={hint} />
          )}
        </>
      )}

      {pending.length > 0 ? (
        <Card style={styles.notice}>
          <Title>
            {pending.length === 1 ? "1 clip waiting" : `${pending.length} clips waiting`}
          </Title>
          <Muted style={{ marginTop: space.xs }}>
            Recorded while the server was out of reach. They’ll be identified as soon as it answers.
          </Muted>
          <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.md }}>
            <Button label="Try now" compact loading={flushing} onPress={() => void flush()} />
            <Button label="Discard" compact variant="ghost" onPress={() => void clearQueue()} />
          </View>
        </Card>
      ) : null}

      {state.phase === "error" ? (
        <Card style={[styles.notice, { borderColor: c.danger }]}>
          <Text style={{ color: c.danger, fontWeight: "700" }}>Couldn’t identify</Text>
          <Muted style={{ marginTop: space.xs }}>{state.error}</Muted>
          <Button label="Dismiss" variant="ghost" compact style={{ marginTop: space.md, alignSelf: "flex-start" }} onPress={reset} />
        </Card>
      ) : null}
    </View>
  );
}

type ModeProps = Pick<ReturnType<typeof useIdentify>, "state" | "start" | "cancel"> & { hint: string };

/**
 * An optional nudge ("90s sitcom", "on Netflix"). Anything the user already knows
 * narrows the search a lot, especially for long-running shows.
 */
function HintField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      editable={!disabled}
      placeholder="Optional hint: “90s sitcom”, “on Netflix”…"
      placeholderTextColor={c.muted}
      maxLength={MAX_HINT_LENGTH}
      returnKeyType="done"
      style={styles.hintField}
      accessibilityLabel="Optional hint about what you are watching"
    />
  );
}

function CameraMode({ state, start, cancel, hint }: ModeProps) {
  const styles = useStyles();
  const c = useTheme();
  const [camPerm, requestCam] = useCameraPermissions();
  const [micPerm, requestMic] = useMicrophonePermissions();
  const cameraRef = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const busy = state.phase === "recording" || state.phase === "uploading";
  useKeepAwake();

  const granted = camPerm?.granted && micPerm?.granted;

  // Leaving the app mid-session ends the recording; the camera can't record in the background.
  useEffect(() => {
    if (!busy) return;
    const sub = AppState.addEventListener("change", (next) => {
      // "inactive" is transient on iOS (notification banner, Control Center); only background ends it.
      if (next === "background") cancel();
    });
    return () => sub.remove();
  }, [busy, cancel]);

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
    void start("camera", producer, { hints: hint.trim() || undefined });
  };

  if (!camPerm || !micPerm) return <ActivityIndicator style={{ marginTop: space.xl }} color={c.accent} />;

  if (!granted) {
    return (
      <Card style={styles.notice}>
        <Title>Camera and microphone</Title>
        <Muted style={{ marginTop: space.sm }}>
          Point your phone at the TV. The camera reads what’s on screen and the microphone picks up dialogue. Nothing is stored after it’s identified.
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
      {!busy ? <ViewfinderFrame /> : null}
      <View style={styles.cameraOverlay} pointerEvents="box-none">
        <StatusPill state={state} />
        <View style={styles.buttonWrap}>
          <SonarRings size={120} active={busy} />
          <Breathing active={busy}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={busy ? "Stop listening" : "Identify"}
              disabled={!ready}
              onPress={onPress}
              style={({ pressed }) => [styles.bigButton, busy && styles.bigButtonBusy, pressed && { transform: [{ scale: 0.96 }] }]}
            >
              {busy ? <View style={styles.stopSquare} /> : <Text style={styles.bigButtonText}>Identify</Text>}
            </Pressable>
          </Breathing>
        </View>
        <Muted style={styles.hint}>
          {busy ? "Tap to stop" : "Frame the screen and hold steady. Dialogue and on-screen text help."}
        </Muted>
      </View>
    </View>
  );
}

function ScreenMode({ state, start, cancel, hint }: ModeProps) {
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
    void start("screen", producer, { maxClips: 1, hints: hint.trim() || undefined });
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
  const styles = useStyles();
  const c = useTheme();
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
      <ActivityIndicator color={c.text} size="small" />
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  brand: { color: c.text, fontSize: 24, fontWeight: "800", letterSpacing: -0.5 },
  topActions: { flexDirection: "row", gap: space.lg },
  topLink: { color: c.accent, fontSize: 16, fontWeight: "600" },
  modeSwitch: {
    flexDirection: "row",
    marginHorizontal: space.lg,
    marginBottom: space.md,
    backgroundColor: c.surface,
    borderRadius: radius.pill,
    padding: 4,
  },
  modeTab: { flex: 1, paddingVertical: 10, borderRadius: radius.pill, alignItems: "center" },
  modeTabActive: { backgroundColor: c.surfaceAlt },
  modeTabText: { color: c.muted, fontWeight: "600" },
  modeTabTextActive: { color: c.text },
  notice: { marginHorizontal: space.lg, marginBottom: space.md },
  hintField: {
    marginHorizontal: space.lg,
    marginBottom: space.md,
    backgroundColor: c.surface,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    color: c.text,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    fontSize: 14,
  },
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
  buttonWrap: { width: 160, height: 160, alignItems: "center", justifyContent: "center" },
  bigButton: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: c.accent,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 6,
    borderColor: "rgba(255,255,255,0.25)",
  },
  bigButtonBusy: { backgroundColor: c.danger },
  bigButtonText: { color: c.accentText, fontSize: 18, fontWeight: "800" },
  stopSquare: { width: 34, height: 34, borderRadius: 6, backgroundColor: c.accentText },
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
  pillText: { color: c.text, fontWeight: "600" },
}));
