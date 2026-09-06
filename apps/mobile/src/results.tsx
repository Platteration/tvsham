import * as WebBrowser from "expo-web-browser";
import { Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import type { Identification, ResolvedLink } from "@tvsham/shared";
import { colors, radius, space } from "./theme";
import { Chip, Muted } from "./ui";

export function kindLabel(kind: Identification["kind"]): string {
  switch (kind) {
    case "movie":
      return "Movie";
    case "tv_episode":
      return "TV episode";
    case "tv_show":
      return "TV show";
    case "youtube":
      return "YouTube";
    case "short_form":
      return "Short video";
    case "other":
      return "Broadcast";
    default:
      return "Unknown";
  }
}

export function subtitleFor(id: Identification): string {
  const parts: string[] = [];
  if (id.episode?.season && id.episode.number) parts.push(`Season ${id.episode.season}, Episode ${id.episode.number}`);
  else if (id.episode?.number) parts.push(`Episode ${id.episode.number}`);
  if (id.episode?.title) parts.push(`“${id.episode.title}”`);
  if (id.creator) parts.push(id.creator);
  if (id.year && !id.episode) parts.push(String(id.year));
  return parts.join(" · ");
}

export async function openLink(link: ResolvedLink): Promise<void> {
  // youtube.com URLs hand off to the YouTube app when it is installed.
  if (link.provider === "youtube") {
    await Linking.openURL(link.url);
    return;
  }
  await WebBrowser.openBrowserAsync(link.url, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET });
}

export function LinkRow({ link }: { link: ResolvedLink }) {
  const badge = link.provider === "youtube" ? "YouTube" : link.provider === "wikipedia" ? "Wikipedia" : "Web";
  const badgeColor = link.provider === "youtube" ? colors.youtube : colors.wikipedia;
  const badgeText = link.provider === "youtube" ? "#fff" : "#111";
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => void openLink(link)}
      style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
    >
      {link.imageUrl ? <Image source={{ uri: link.imageUrl }} style={styles.linkThumb} /> : <View style={[styles.linkThumb, styles.linkThumbEmpty]} />}
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
          <Chip label={badge} color={badgeColor} textColor={badgeText} />
          {link.confidence === "search" ? <Muted>search</Muted> : null}
        </View>
        <Text style={styles.linkTitle} numberOfLines={2}>
          {link.title}
        </Text>
        {link.description ? (
          <Muted numberOfLines={2} style={{ fontSize: 13 }}>
            {link.description}
          </Muted>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  linkRow: {
    flexDirection: "row",
    gap: space.md,
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  linkThumb: { width: 64, height: 64, borderRadius: radius.sm, backgroundColor: colors.surfaceAlt },
  linkThumbEmpty: { opacity: 0.6 },
  linkTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
});
