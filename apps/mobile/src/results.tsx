import * as WebBrowser from "expo-web-browser";
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { CastMember, Identification, ResolvedLink, WatchOption } from "@tvsham/shared";
import { makeStyles, radius, space, useTheme, type Palette } from "./theme";
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

/** Providers whose own app should open the link when it is installed. */
const NATIVE_APP_PROVIDERS = new Set<ResolvedLink["provider"]>(["youtube", "tiktok", "instagram"]);

export async function openLink(link: ResolvedLink): Promise<void> {
  if (NATIVE_APP_PROVIDERS.has(link.provider)) {
    await Linking.openURL(link.url);
    return;
  }
  await WebBrowser.openBrowserAsync(link.url, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET });
}

function providerBadge(c: Palette, provider: ResolvedLink["provider"]): { label: string; color: string; text: string } {
  switch (provider) {
    case "wikipedia":
      return { label: "Wikipedia", color: c.wikipedia, text: "#111" };
    case "youtube":
      return { label: "YouTube", color: c.youtube, text: "#fff" };
    case "tiktok":
      return { label: "TikTok", color: c.tiktok, text: "#111" };
    case "instagram":
      return { label: "Instagram", color: c.instagram, text: "#fff" };
    default:
      return { label: "Web", color: c.surfaceAlt, text: c.text };
  }
}

/** The verb for the button that opens this link. */
export function actionLabel(link: ResolvedLink): string {
  if (link.provider === "wikipedia") return "Read on Wikipedia";
  if (link.confidence === "search") return "Search for it";
  return "Watch now";
}

export function LinkRow({ link }: { link: ResolvedLink }) {
  const c = useTheme();
  const styles = useStyles();
  const badge = providerBadge(c, link.provider);
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => void openLink(link)}
      style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
    >
      {link.imageUrl ? <Image source={{ uri: link.imageUrl }} style={styles.linkThumb} /> : <View style={[styles.linkThumb, styles.linkThumbEmpty]} />}
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
          <Chip label={badge.label} color={badge.color} textColor={badge.text} />
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

const WATCH_LABEL: Record<WatchOption["kind"], string> = {
  stream: "Streaming",
  rent: "Rent",
  buy: "Buy",
};

/** One service the title is available on. Tapping opens TMDB's list of providers. */
export function WatchRow({ options }: { options: WatchOption[] }) {
  const styles = useStyles();
  return (
    <View style={styles.wrapRow}>
      {options.map((o) => (
        <Pressable
          key={`${o.kind}-${o.service}`}
          onPress={() => void WebBrowser.openBrowserAsync(o.url)}
          style={({ pressed }) => [styles.watchChip, pressed && { opacity: 0.7 }]}
          accessibilityRole="link"
          accessibilityLabel={`${o.service}, ${WATCH_LABEL[o.kind]}`}
        >
          {o.logoUrl ? <Image source={{ uri: o.logoUrl }} style={styles.watchLogo} /> : null}
          <View>
            <Text style={styles.watchService} numberOfLines={1}>
              {o.service}
            </Text>
            <Muted style={{ fontSize: 11 }}>{WATCH_LABEL[o.kind]}</Muted>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

/** Who is on screen. Answers the "wait, who is that?" question without leaving the app. */
export function CastStrip({ cast }: { cast: CastMember[] }) {
  const styles = useStyles();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.md }}>
      {cast.map((c) => (
        <Pressable
          key={`${c.name}-${c.character ?? ""}`}
          disabled={!c.url}
          onPress={() => c.url && void WebBrowser.openBrowserAsync(c.url)}
          style={({ pressed }) => [styles.castCard, pressed && { opacity: 0.7 }]}
        >
          {c.imageUrl ? (
            <Image source={{ uri: c.imageUrl }} style={styles.castPhoto} />
          ) : (
            <View style={[styles.castPhoto, styles.castPhotoEmpty]}>
              <Text style={styles.castInitial}>{c.name.slice(0, 1)}</Text>
            </View>
          )}
          <Text style={styles.castName} numberOfLines={2}>
            {c.name}
          </Text>
          {c.character ? (
            <Muted style={{ fontSize: 11 }} numberOfLines={1}>
              {c.character}
            </Muted>
          ) : null}
        </Pressable>
      ))}
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  wrapRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  watchChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: c.surface,
    borderRadius: radius.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
  },
  watchLogo: { width: 28, height: 28, borderRadius: 6, backgroundColor: c.surfaceAlt },
  watchService: { color: c.text, fontSize: 14, fontWeight: "600", maxWidth: 150 },
  castCard: { width: 82, gap: 4 },
  castPhoto: { width: 82, height: 104, borderRadius: radius.sm, backgroundColor: c.surfaceAlt },
  castPhotoEmpty: { alignItems: "center", justifyContent: "center" },
  castInitial: { color: c.muted, fontSize: 28, fontWeight: "700" },
  castName: { color: c.text, fontSize: 12, fontWeight: "600" },
  linkRow: {
    flexDirection: "row",
    gap: space.md,
    alignItems: "center",
    backgroundColor: c.surface,
    borderRadius: radius.md,
    padding: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
  },
  linkThumb: { width: 64, height: 64, borderRadius: radius.sm, backgroundColor: c.surfaceAlt },
  linkThumbEmpty: { opacity: 0.6 },
  linkTitle: { color: c.text, fontSize: 15, fontWeight: "600" },
}));
