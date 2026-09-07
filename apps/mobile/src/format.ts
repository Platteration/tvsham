/**
 * Turning an identification into the words and colours the UI shows.
 * Pure: no React, no React Native, so it can be tested directly.
 */
import type { Identification, ResolvedLink, WatchOption } from "@tvsham/shared";
import type { Palette } from "./palette";

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

export function providerBadge(c: Palette, provider: ResolvedLink["provider"]): { label: string; color: string; text: string } {
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

/**
 * Links arrive from the server as strings. The server builds them soundly, but
 * the app talks to it over plain HTTP by default, so anyone on the same network
 * could rewrite one. Only web schemes are ever handed to the OS: on Android a
 * scheme like intent:// would launch another app entirely.
 */
export function isSafeWebUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** An image source is only used when it is a web URL; anything else is dropped. */
export function safeImageUri(raw: string | undefined): string | undefined {
  return raw && isSafeWebUrl(raw) ? raw : undefined;
}

export const WATCH_LABEL: Record<WatchOption["kind"], string> = {
  stream: "Streaming",
  rent: "Rent",
  buy: "Buy",
};
