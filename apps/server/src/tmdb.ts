/**
 * Optional TMDB enrichment: where to watch, and who is in it.
 * Everything here degrades to an empty result when TMDB_API_KEY is unset.
 *
 * This product uses the TMDB API but is not endorsed or certified by TMDB.
 */
import type { CastMember, Identification, WatchOption } from "@tvsham/shared";
import { config } from "./config.js";
import { getJson } from "./http.js";

const IMAGE_BASE = "https://image.tmdb.org/t/p";

interface SearchResult {
  results?: Array<{ id: number; name?: string; title?: string; popularity?: number }>;
}

interface ProvidersResponse {
  results?: Record<
    string,
    {
      link?: string;
      flatrate?: ProviderEntry[];
      rent?: ProviderEntry[];
      buy?: ProviderEntry[];
      free?: ProviderEntry[];
      ads?: ProviderEntry[];
    }
  >;
}

interface ProviderEntry {
  provider_name: string;
  logo_path?: string | null;
}

interface CreditsResponse {
  cast?: Array<{ id: number; name: string; character?: string; profile_path?: string | null }>;
}

function api(path: string, params: Record<string, string> = {}): string | null {
  if (!config.tmdbApiKey) return null;
  const u = new URL(`https://api.themoviedb.org/3${path}`);
  u.searchParams.set("api_key", config.tmdbApiKey);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** TMDB only knows films and television; everything else has no entry to find. */
export function tmdbType(id: Identification): "movie" | "tv" | null {
  if (id.kind === "movie") return "movie";
  if (id.kind === "tv_show" || id.kind === "tv_episode") return "tv";
  return null;
}

/** Find the TMDB id for an identification, or null when there is nothing to match. */
export async function findId(id: Identification): Promise<{ type: "movie" | "tv"; id: number } | null> {
  const type = tmdbType(id);
  if (!type || !id.title) return null;
  const params: Record<string, string> = { query: id.title };
  if (id.year) params[type === "movie" ? "primary_release_year" : "first_air_date_year"] = String(id.year);
  const url = api(`/search/${type}`, params);
  if (!url) return null;
  const found = await getJson<SearchResult>(url);
  const best = found?.results?.[0];
  return best ? { type, id: best.id } : null;
}

/** Streaming, rental and purchase options for a region (an ISO 3166-1 country code). */
export async function watchOptions(
  ref: { type: "movie" | "tv"; id: number },
  region: string,
): Promise<WatchOption[]> {
  const url = api(`/${ref.type}/${ref.id}/watch/providers`);
  if (!url) return [];
  const res = await getJson<ProvidersResponse>(url);
  const forRegion = res?.results?.[region.toUpperCase()];
  if (!forRegion?.link) return [];

  const seen = new Set<string>();
  const out: WatchOption[] = [];
  const groups: Array<[WatchOption["kind"], ProviderEntry[] | undefined]> = [
    ["stream", [...(forRegion.flatrate ?? []), ...(forRegion.free ?? []), ...(forRegion.ads ?? [])]],
    ["rent", forRegion.rent],
    ["buy", forRegion.buy],
  ];
  for (const [kind, entries] of groups) {
    for (const e of entries ?? []) {
      if (seen.has(e.provider_name)) continue;
      seen.add(e.provider_name);
      out.push({
        kind,
        service: e.provider_name,
        // TMDB's own page is the only link they permit; it lists every provider for the title.
        url: forRegion.link,
        ...(e.logo_path ? { logoUrl: `${IMAGE_BASE}/w185${e.logo_path}` } : {}),
      });
    }
  }
  return out;
}

/** Top billed cast, capped so the result card stays readable. */
export async function topCast(ref: { type: "movie" | "tv"; id: number }, limit = 8): Promise<CastMember[]> {
  const url = api(`/${ref.type}/${ref.id}/credits`);
  if (!url) return [];
  const res = await getJson<CreditsResponse>(url);
  return (res?.cast ?? []).slice(0, limit).map((c) => ({
    name: c.name,
    url: `https://www.themoviedb.org/person/${c.id}`,
    ...(c.character ? { character: c.character } : {}),
    ...(c.profile_path ? { imageUrl: `${IMAGE_BASE}/w185${c.profile_path}` } : {}),
  }));
}

/** Both lookups at once. Failures are non-fatal: the answer still stands without them. */
export async function enrich(
  id: Identification,
  region: string,
): Promise<{ watch: WatchOption[]; cast: CastMember[] }> {
  const empty = { watch: [], cast: [] };
  if (!config.tmdbApiKey) return empty;
  try {
    const ref = await findId(id);
    if (!ref) return empty;
    const [watch, cast] = await Promise.all([watchOptions(ref, region), topCast(ref)]);
    return { watch, cast };
  } catch (err) {
    console.warn("[tmdb] enrichment failed", err);
    return empty;
  }
}
