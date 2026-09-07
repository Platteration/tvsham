import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { ConfidenceRing } from "@/motion";
import { CastStrip, LinkRow, WatchRow, actionLabel, kindLabel, openLink, subtitleFor } from "@/results";
import { isSaved, saveResult, useLastResult, useLibrary } from "@/store";
import { makeStyles, radius, space, useTheme } from "@/theme";
import { Body, Button, Card, Chip, Empty, Muted, Title } from "@/ui";

export default function ResultScreen() {
  const styles = useStyles();
  const c = useTheme();
  const last = useLastResult();
  const library = useLibrary();
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  if (!last?.result.identification) {
    return <Empty title="Nothing to show" hint="Identify something first." />;
  }
  const { result, source } = last;
  const id = result.identification!;
  const saved = library.some((i) => i.id === result.sessionId) || isSaved(result);
  const primary = result.links[0];
  const hero = result.links.find((l) => l.imageUrl)?.imageUrl;
  const confident = result.status === "identified";

  const onSave = async () => {
    setSaving(true);
    await saveResult(result, source);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSaving(false);
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Card>
        <View style={{ flexDirection: "row", gap: space.md, alignItems: "center" }}>
          <ConfidenceRing value={id.confidence} />
          <View style={{ flex: 1, gap: space.xs }}>
            <Chip label={kindLabel(id.kind)} color={c.accent} textColor={c.accentText} />
            <Muted>
              {confident ? "Confident match" : result.status === "unsure" ? "Best guess" : "Low confidence"}
            </Muted>
          </View>
        </View>
        {hero ? (
          <View style={styles.heroWrap}>
            <Image source={{ uri: hero }} style={styles.heroBackdrop} resizeMode="cover" blurRadius={18} />
            <Image source={{ uri: hero }} style={styles.heroImage} resizeMode="contain" />
          </View>
        ) : null}
        <Title style={{ marginTop: space.md }}>{id.title}</Title>
        {subtitleFor(id) ? <Body style={{ color: c.muted, marginTop: 2 }}>{subtitleFor(id)}</Body> : null}
        <Muted style={{ marginTop: space.md }}>{id.evidence}</Muted>
        <Muted style={{ marginTop: space.xs, fontSize: 12 }}>
          {source === "camera" ? "From the camera" : "From a screen recording"} · {result.secondsAnalysed}s analysed
        </Muted>
      </Card>

      {result.links.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Muted style={{ marginLeft: space.xs }}>Open</Muted>
          {result.links.map((l) => (
            <LinkRow key={l.url} link={l} />
          ))}
        </View>
      ) : (
        <Card>
          <Muted>No links found for this. Try again with dialogue or a title visible on screen.</Muted>
        </Card>
      )}

      {result.watch.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Muted style={{ marginLeft: space.xs }}>Where to watch</Muted>
          <WatchRow options={result.watch} />
        </View>
      ) : null}

      {result.cast.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Muted style={{ marginLeft: space.xs }}>Who's in it</Muted>
          <CastStrip cast={result.cast} />
        </View>
      ) : null}

      {id.alternatives && id.alternatives.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Muted style={{ marginLeft: space.xs }}>Not this? It might be</Muted>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {id.alternatives.map((a) => (
              <Pressable
                key={`${a.title}-${a.year ?? ""}`}
                onPress={() =>
                  void WebBrowser.openBrowserAsync(
                    `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(a.year ? `${a.title} ${a.year}` : a.title)}`,
                  )
                }
              >
                <Chip label={a.year ? `${a.title} (${a.year})` : a.title} />
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      <View style={{ gap: space.sm, marginTop: space.md }}>
        {primary ? <Button label={actionLabel(primary)} onPress={() => void openLink(primary)} /> : null}
        <Button
          label={saved ? "Saved for later ✓" : "Save for later"}
          variant="secondary"
          loading={saving}
          disabled={saved}
          onPress={() => void onSave()}
        />
        <Button label="Try again" variant="ghost" onPress={() => router.back()} />
      </View>
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  container: { padding: space.lg, gap: space.lg, paddingBottom: space.xl * 2 },
  heroWrap: {
    width: "100%",
    height: 190,
    borderRadius: radius.md,
    marginTop: space.md,
    overflow: "hidden",
    backgroundColor: c.surfaceAlt,
  },
  heroBackdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: 0.55 },
  heroImage: { width: "100%", height: "100%" },
}));
