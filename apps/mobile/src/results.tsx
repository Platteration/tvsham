import * as WebBrowser from "expo-web-browser";
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { CastMember, ResolvedLink, WatchOption } from "@tvsham/shared";
import { WATCH_LABEL, providerBadge } from "./format";
import { makeStyles, radius, space, useTheme } from "./theme";
import { Chip, Muted } from "./ui";

export { actionLabel, kindLabel, subtitleFor } from "./format";

/** Providers whose own app should open the link when it is installed. */
const NATIVE_APP_PROVIDERS = new Set<ResolvedLink["provider"]>(["youtube", "tiktok", "instagram"]);

export async function openLink(link: ResolvedLink): Promise<void> {
  if (NATIVE_APP_PROVIDERS.has(link.provider)) {
    await Linking.openURL(link.url);
    return;
  }
  await WebBrowser.openBrowserAsync(link.url, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET });
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
