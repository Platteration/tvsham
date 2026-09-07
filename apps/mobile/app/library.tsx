import { Alert, Image, Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import type { SavedItem } from "@tvsham/shared";
import { clearHistory, removeSaved, saveHistoryItem, setWatched, useHistory, useLibrary } from "@/store";
import { makeStyles, radius, space, useTheme } from "@/theme";
import { Button, Chip, Empty, Muted } from "@/ui";
import { actionLabel, kindLabel, openLink, subtitleFor } from "@/results";

function Row({ item, recent }: { item: SavedItem; recent?: boolean }) {
  const styles = useStyles();
  const c = useTheme();
  const primary = item.links[0];
  const thumb = item.links.find((l) => l.imageUrl)?.imageUrl;
  const confirmRemove = () =>
    Alert.alert("Remove from saved?", item.identification.title, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void removeSaved(item.id) },
    ]);

  return (
    <Pressable
      onPress={() => primary && void openLink(primary)}
      onLongPress={recent ? undefined : confirmRemove}
      accessibilityRole="button"
      accessibilityLabel={`${item.identification.title}${item.watched ? ", watched" : ""}`}
      accessibilityHint={primary ? actionLabel(primary) : undefined}
      style={({ pressed }) => [styles.row, item.watched && styles.rowWatched, pressed && { opacity: 0.7 }]}
    >
      {thumb ? <Image source={{ uri: thumb }} style={styles.thumb} /> : <View style={[styles.thumb, { opacity: 0.5 }]} />}
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
          <Chip label={kindLabel(item.identification.kind)} />
          {item.watched ? <Chip label="Watched" color={c.success} textColor="#111" /> : null}
        </View>
        <Text style={styles.title} numberOfLines={2}>
          {item.identification.title}
        </Text>
        {subtitleFor(item.identification) ? <Muted numberOfLines={1}>{subtitleFor(item.identification)}</Muted> : null}
        <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.xs, flexWrap: "wrap" }}>
          {primary ? (
            <Button label={primary.provider === "wikipedia" ? "Read" : "Open"} compact onPress={() => void openLink(primary)} />
          ) : null}
          {recent ? (
            <Button label="Save for later" compact variant="secondary" onPress={() => void saveHistoryItem(item)} />
          ) : (
            <>
              <Button
                label={item.watched ? "Unwatched" : "Watched"}
                compact
                variant="secondary"
                onPress={() => void setWatched(item.id, !item.watched)}
              />
              <Button label="Remove" compact variant="ghost" onPress={confirmRemove} />
            </>
          )}
        </View>
      </View>
    </Pressable>
  );
}

export default function LibraryScreen() {
  const styles = useStyles();
  const saved = useLibrary();
  const history = useHistory();
  const savedIds = new Set(saved.map((i) => i.id));
  const recent = history.filter((i) => !savedIds.has(i.id));

  if (saved.length === 0 && recent.length === 0) {
    return <Empty title="Nothing here yet" hint="Identify something and tap “Save for later”. Everything you identify also shows up under Recent." />;
  }

  const sections = [
    ...(saved.length ? [{ title: "Saved for later", data: saved, recent: false }] : []),
    ...(recent.length ? [{ title: "Recent", data: recent, recent: true }] : []),
  ];

  return (
    <SectionList
      sections={sections}
      keyExtractor={(i) => i.id}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => (
        <View style={styles.header}>
          <Text style={styles.headerText}>{section.title}</Text>
          {section.recent ? (
            <Pressable
              hitSlop={8}
              onPress={() => void clearHistory()}
              accessibilityRole="button"
              accessibilityLabel="Clear recent identifications"
            >
              <Muted>Clear</Muted>
            </Pressable>
          ) : null}
        </View>
      )}
      renderItem={({ item, section }) => <Row item={item} recent={section.recent} />}
      contentContainerStyle={{ padding: space.lg, gap: space.md }}
      SectionSeparatorComponent={() => <View style={{ height: space.sm }} />}
    />
  );
}

const useStyles = makeStyles((c) => ({
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: space.xs },
  headerText: { color: c.muted, fontSize: 13, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 },
  row: {
    flexDirection: "row",
    gap: space.md,
    backgroundColor: c.surface,
    borderRadius: radius.md,
    padding: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
  },
  rowWatched: { opacity: 0.75 },
  thumb: { width: 72, height: 72, borderRadius: radius.sm, backgroundColor: c.surfaceAlt },
  title: { color: c.text, fontSize: 16, fontWeight: "700" },
}));
