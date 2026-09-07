import type { Identification, ResolvedLink } from "@tvsham/shared";
import { config } from "./config.js";
import { getJson } from "./http.js";

interface WikiSummary {
  title: string;
  extract?: string;
  description?: string;
  thumbnail?: { source: string };
  content_urls?: { mobile?: { page: string }; desktop?: { page: string } };
  type?: string;
}

/** Look up a Wikipedia page by exact title, falling back to title search. */
export async function wikipediaLink(title: string, lang = config.wikipediaLang): Promise<ResolvedLink | null> {
  const base = `https://${lang}.wikipedia.org`;
  const tryTitle = async (t: string): Promise<ResolvedLink | null> => {
    const s = await getJson<WikiSummary>(
      `${base}/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, "_"))}?redirect=true`,
    );
    if (!s || s.type === "disambiguation" || !s.content_urls) return null;
    const link: ResolvedLink = {
      provider: "wikipedia",
      url: s.content_urls.mobile?.page ?? s.content_urls.desktop?.page ?? `${base}/wiki/${encodeURIComponent(t)}`,
      title: s.title,
      confidence: "verified",
    };
    if (s.extract) link.description = s.extract;
    else if (s.description) link.description = s.description;
    if (s.thumbnail?.source) link.imageUrl = s.thumbnail.source;
    return link;
  };

  const direct = await tryTitle(title);
  if (direct) return direct;

  const search = await getJson<{ pages?: Array<{ title: string }> }>(
    `${base}/w/rest.php/v1/search/title?q=${encodeURIComponent(title)}&limit=3`,
  );
  for (const p of search?.pages ?? []) {
    const hit = await tryTitle(p.title);
    if (hit) return hit;
  }
  return null;
}

interface OEmbed {
  title: string;
  author_name?: string;
  thumbnail_url?: string;
}

/** Verify a YouTube URL exists via oEmbed (no API key needed). */
export async function youtubeLinkFromUrl(url: string): Promise<ResolvedLink | null> {
  const id = youtubeId(url);
  if (!id) return null;
  const canonical = `https://www.youtube.com/watch?v=${id}`;
  const o = await getJson<OEmbed>(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`,
  );
  if (!o) return null;
  const link: ResolvedLink = {
    provider: "youtube",
    url: canonical,
    title: o.title,
    confidence: "verified",
  };
  if (o.author_name) link.description = o.author_name;
  if (o.thumbnail_url) link.imageUrl = o.thumbnail_url;
  return link;
}

export function youtubeId(url: string): string | null {
  const m =
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(url);
  return m?.[1] ?? null;
}

/** Search YouTube with the Data API when a key is configured. */
export async function youtubeSearch(query: string): Promise<ResolvedLink | null> {
  if (!config.youtubeApiKey) return null;
  const u = new URL("https://www.googleapis.com/youtube/v3/search");
  u.searchParams.set("part", "snippet");
  u.searchParams.set("type", "video");
  u.searchParams.set("maxResults", "1");
  u.searchParams.set("q", query);
  u.searchParams.set("key", config.youtubeApiKey);
  const r = await getJson<{
    items?: Array<{ id: { videoId: string }; snippet: { title: string; channelTitle: string; thumbnails?: { high?: { url: string } } } }>;
  }>(u.toString());
  const item = r?.items?.[0];
  if (!item) return null;
  const link: ResolvedLink = {
    provider: "youtube",
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    title: item.snippet.title,
    description: item.snippet.channelTitle,
    confidence: "unverified",
  };
  if (item.snippet.thumbnails?.high?.url) link.imageUrl = item.snippet.thumbnails.high.url;
  return link;
}

export function youtubeSearchLink(query: string): ResolvedLink {
  return {
    provider: "youtube",
    url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    title: `Search YouTube for “${query}”`,
    confidence: "search",
  };
}

export function wikipediaSearchLink(query: string): ResolvedLink {
  return {
    provider: "wikipedia",
    url: `https://${config.wikipediaLang}.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`,
    title: `Search Wikipedia for “${query}”`,
    confidence: "search",
  };
}

/** Hosts we are willing to build a link to, mapped to how their URLs are shaped. */
const PLATFORMS = {
  tiktok: {
    provider: "tiktok" as const,
    label: "TikTok",
    host: /(^|\.)tiktok\.com$/,
    profile: (handle: string) => `https://www.tiktok.com/@${handle}`,
    search: (q: string) => `https://www.tiktok.com/search?q=${encodeURIComponent(q)}`,
  },
  instagram: {
    provider: "instagram" as const,
    label: "Instagram",
    host: /(^|\.)instagram\.com$/,
    profile: (handle: string) => `https://www.instagram.com/${handle}/`,
    search: (q: string) => `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`,
  },
} as const;

type KnownPlatform = keyof typeof PLATFORMS;

function isKnownPlatform(p: string | undefined): p is KnownPlatform {
  return p === "tiktok" || p === "instagram";
}

/**
 * Accept a platform URL only when its host really is that platform's, so a
 * mis-attributed URL from the model cannot send the user somewhere unexpected.
 */
export function platformVideoLink(id: Identification): ResolvedLink | null {
  if (!id.videoUrl || !isKnownPlatform(id.platform)) return null;
  const spec = PLATFORMS[id.platform];
  let host: string;
  try {
    const u = new URL(id.videoUrl);
    if (u.protocol !== "https:") return null;
    host = u.hostname;
  } catch {
    return null;
  }
  if (!spec.host.test(host)) return null;
  const link: ResolvedLink = {
    provider: spec.provider,
    url: id.videoUrl,
    title: id.title,
    confidence: "unverified",
  };
  if (id.creator) link.description = id.creator;
  return link;
}

/** A link to the creator's own page on the platform the video came from. */
export function creatorProfileLink(id: Identification): ResolvedLink | null {
  const handle = id.creatorHandle?.replace(/^@/, "").trim();
  if (!handle || !/^[A-Za-z0-9._-]{2,50}$/.test(handle)) return null;
  if (isKnownPlatform(id.platform)) {
    const spec = PLATFORMS[id.platform];
    return {
      provider: spec.provider,
      url: spec.profile(handle),
      title: `@${handle} on ${spec.label}`,
      confidence: "unverified",
      ...(id.creator ? { description: id.creator } : {}),
    };
  }
  if (id.platform === "youtube" || id.kind === "youtube") {
    return {
      provider: "youtube",
      url: `https://www.youtube.com/@${handle}`,
      title: `@${handle} on YouTube`,
      confidence: "unverified",
      ...(id.creator ? { description: id.creator } : {}),
    };
  }
  return null;
}

/**
 * A trailer for a film or show. With a YouTube key this is a real search hit;
 * without one it is a YouTube search URL, which still lands the user in the right place.
 * Episodes are left out: someone mid-episode wants the article, not a series trailer.
 */
export async function trailerLink(id: Identification): Promise<ResolvedLink | null> {
  if (id.kind !== "movie" && id.kind !== "tv_show") return null;
  const query = [id.title, id.year, "trailer"].filter(Boolean).join(" ");
  const hit = await youtubeSearch(query);
  if (hit) return { ...hit, title: `Trailer: ${hit.title}` };
  return {
    provider: "youtube",
    url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    title: `Trailer for ${id.title}`,
    confidence: "search",
  };
}

function episodeLabel(id: Identification): string {
  const e = id.episode;
  if (!e) return "";
  const parts: string[] = [];
  if (e.season && e.number) parts.push(`S${e.season}E${e.number}`);
  else if (e.number) parts.push(`Episode ${e.number}`);
  if (e.title) parts.push(`“${e.title}”`);
  return parts.join(" ");
}

/**
 * Turn an identification into openable links. Verified links come first; a
 * search-URL fallback is always appended so the user is never left with nothing.
 */
export async function resolveLinks(id: Identification): Promise<ResolvedLink[]> {
  const links: ResolvedLink[] = [];
  if (id.kind === "unknown" || id.confidence <= 0) return links;

  const isVideoPlatform = id.kind === "youtube" || id.kind === "short_form";

  if (isVideoPlatform) {
    // A TikTok or Reel belongs on its own platform; only fall back to YouTube for the rest.
    const native = platformVideoLink(id);
    if (native) links.push(native);
    if (links.length === 0 && id.youtubeUrl) {
      const v = await youtubeLinkFromUrl(id.youtubeUrl);
      if (v) links.push(v);
    }
    if (links.length === 0) {
      const q = [id.title, id.creator].filter(Boolean).join(" ");
      if (isKnownPlatform(id.platform)) {
        const spec = PLATFORMS[id.platform];
        links.push({ provider: spec.provider, url: spec.search(q), title: `Search ${spec.label} for “${q}”`, confidence: "search" });
      } else {
        links.push((await youtubeSearch(q)) ?? youtubeSearchLink(q));
      }
    }
    const profile = creatorProfileLink(id);
    if (profile) links.push(profile);
    // Creators often have a Wikipedia article even when the video does not.
    if (id.wikipediaTitle) {
      const w = await wikipediaLink(id.wikipediaTitle);
      if (w) links.push(w);
    }
    return links;
  }

  // Movies / shows / episodes → Wikipedia first.
  const tried = new Set<string>();
  const candidates: string[] = [];
  if (id.kind === "tv_episode" && id.wikipediaEpisodeTitle) candidates.push(id.wikipediaEpisodeTitle);
  if (id.kind === "tv_episode" && id.episode?.title) candidates.push(`${id.episode.title} (${id.title})`);
  if (id.wikipediaTitle) candidates.push(id.wikipediaTitle);
  if (id.kind === "movie") candidates.push(id.year ? `${id.title} (${id.year} film)` : `${id.title} (film)`);
  if (id.kind === "tv_show" || id.kind === "tv_episode") candidates.push(`${id.title} (TV series)`);
  candidates.push(id.title);

  for (const c of candidates) {
    const key = c.toLowerCase();
    if (tried.has(key)) continue;
    tried.add(key);
    const w = await wikipediaLink(c);
    if (w && !links.some((l) => l.url === w.url)) {
      links.push(w);
      // One article for the episode plus one for the show is plenty.
      if (links.length >= 2) break;
      // If we already have the show article and there is no episode info, stop.
      if (id.kind !== "tv_episode") break;
    }
  }

  if (links.length === 0) {
    links.push(wikipediaSearchLink([id.title, episodeLabel(id)].filter(Boolean).join(" ")));
  }

  // A clip the model found, then a trailer, so there is always something to watch.
  if (id.youtubeUrl) {
    const v = await youtubeLinkFromUrl(id.youtubeUrl);
    if (v) links.push(v);
  }
  if (!links.some((l) => l.provider === "youtube")) {
    const trailer = await trailerLink(id);
    if (trailer) links.push(trailer);
  }
  return links;
}
