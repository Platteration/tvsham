import { Alert, FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { SavedItem } from "@tvsham/shared";
import { removeSaved, setWatched, useLibrary } from "@/store";
import { colors, radius, space } from "@/theme";
import { Button, Chip, Empty, Muted } from "@/ui";
import { kindLabel, openLink, subtitleFor } from "@/results";

function Row({ item }: { item: SavedItem }) {
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
      onLongPress={confirmRemove}
      style={({ pressed }) => [styles.row, item.watched && styles.rowWatched, pressed && { opacity: 0.7 }]}
    >
      {thumb ? <Image source={{ uri: thumb }} style={styles.thumb} /> : <View style={[styles.thumb, { opacity: 0.5 }]} />}
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
          <Chip label={kindLabel(item.identification.kind)} />
          {item.watched ? <Chip label="Watched" color={colors.success} textColor="#111" /> : null}
        </View>
        <Text style={styles.title} numberOfLines={2}>
          {item.identification.title}
        </Text>
        {subtitleFor(item.identification) ? <Muted numberOfLines={1}>{subtitleFor(item.identification)}</Muted> : null}
        <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.xs }}>
          {primary ? (
            <Button label={primary.provider === "youtube" ? "Watch" : "Read"} compact onPress={() => void openLink(primary)} />
          ) : null}
          <Button
            label={item.watched ? "Unwatched" : "Watched"}
            compact
            variant="secondary"
            onPress={() => void setWatched(item.id, !item.watched)}
          />
          <Button label="Remove" compact variant="ghost" onPress={confirmRemove} />
        </View>
      </View>
    </Pressable>
  );
}

export default function LibraryScreen() {
  const items = useLibrary();
  if (items.length === 0) {
    return <Empty title="Nothing saved yet" hint="Identify something and tap “Save for later”. It shows up here so you can watch it when you have time." />;
  }
  return (
    <FlatList
      data={items}
      keyExtractor={(i) => i.id}
      renderItem={({ item }) => <Row item={item} />}
      contentContainerStyle={{ padding: space.lg, gap: space.md }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  rowWatched: { opacity: 0.75 },
  thumb: { width: 72, height: 72, borderRadius: radius.sm, backgroundColor: colors.surfaceAlt },
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
});
