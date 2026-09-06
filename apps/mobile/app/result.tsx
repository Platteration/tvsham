import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { LinkRow, kindLabel, openLink, subtitleFor } from "@/results";
import { isSaved, saveResult, useLastResult, useLibrary } from "@/store";
import { colors, radius, space } from "@/theme";
import { Body, Button, Card, Chip, Empty, Muted, Title } from "@/ui";

export default function ResultScreen() {
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
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center", flexWrap: "wrap" }}>
          <Chip label={kindLabel(id.kind)} color={colors.accent} textColor={colors.accentText} />
          <Chip
            label={confident ? "Match" : result.status === "unsure" ? "Best guess" : "Not sure"}
            color={confident ? colors.success : colors.warning}
            textColor="#111"
          />
          <Muted>{Math.round(id.confidence * 100)}% sure</Muted>
        </View>
        {primary?.imageUrl ? <Image source={{ uri: primary.imageUrl }} style={styles.hero} resizeMode="cover" /> : null}
        <Title style={{ marginTop: space.md }}>{id.title}</Title>
        {subtitleFor(id) ? <Body style={{ color: colors.muted, marginTop: 2 }}>{subtitleFor(id)}</Body> : null}
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
        {primary ? <Button label={primary.provider === "youtube" ? "Watch now" : "Read on Wikipedia"} onPress={() => void openLink(primary)} /> : null}
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

const styles = StyleSheet.create({
  container: { padding: space.lg, gap: space.lg, paddingBottom: space.xl * 2 },
  hero: { width: "100%", height: 180, borderRadius: radius.md, marginTop: space.md, backgroundColor: colors.surfaceAlt },
});
