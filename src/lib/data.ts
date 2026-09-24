import { getCollection, type CollectionEntry } from 'astro:content';

export type Artist = CollectionEntry<'artists'>;
export type Location = CollectionEntry<'locations'>;
export type Video = CollectionEntry<'videos'>;

export interface Shot {
  image: string;
  set?: { id: string; name: string };
}

/** A video filmed at a location (one per video × location). */
export interface Appearance {
  video: Video;
  location: Location;
  shots: Shot[];
  confidence?: string;
  notes?: string;
}

export interface Pin {
  id: string;
  name: string;
  lat: number;
  lng: number;
  count: number;
  href: string;
}

const collator = new Intl.Collator(['en', 'ko'], { sensitivity: 'base', numeric: true });
export const byName = <T extends { data: { name: string } }>(a: T, b: T) => collator.compare(a.data.name, b.data.name);

function group<T>(items: T[], key: (item: T) => string[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    for (const k of key(item)) {
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(item);
    }
  }
  return map;
}

async function load() {
  const [artists, locations, videos] = await Promise.all([
    getCollection('artists'),
    getCollection('locations'),
    getCollection('videos'),
  ]);
  artists.sort(byName);
  locations.sort(byName);

  const artistById = new Map(artists.map((a) => [a.id, a]));
  const locationById = new Map(locations.map((l) => [l.id, l]));

  const appearances: Appearance[] = videos.flatMap((video) =>
    (video.data.appearances ?? []).map((a) => {
      const location = locationById.get(a.location.id)!;
      const sets = new Map((location.data.sets ?? []).map((s) => [s.id, s]));
      return {
        video,
        location,
        shots: (a.screenshots ?? []).map((s) => ({ image: s.image, set: s.set ? sets.get(s.set) : undefined })),
        confidence: a.confidence,
        notes: a.notes,
      };
    }),
  );

  const appearancesByLocation = group(appearances, (a) => [a.location.id]);
  const appearancesByVideo = group(appearances, (a) => [a.video.id]);
  const videosByArtist = group(videos, (v) => (v.data.artists ?? []).map((a) => a.id));

  const tagCounts = new Map<string, number>();
  for (const l of locations) for (const t of l.data.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const tags = [...tagCounts.entries()]
    .map(([name, count]) => ({ name, slug: slugify(name), count }))
    .sort((a, b) => collator.compare(a.name, b.name));

  return {
    artists,
    locations,
    videos,
    appearances,
    tags,
    artist: (id: string) => artistById.get(id),
    location: (id: string) => locationById.get(id),
    videoArtists: (v: Video) => (v.data.artists ?? []).map((a) => artistById.get(a.id)!).filter(Boolean),
    atLocation: (id: string) => appearancesByLocation.get(id) ?? [],
    ofVideo: (id: string) => appearancesByVideo.get(id) ?? [],
    byArtist: (id: string) => videosByArtist.get(id) ?? [],
  };
}

let cached: ReturnType<typeof load> | undefined;
/** The whole database, loaded once per build. */
export const db = () => (cached ??= load());

// ------------------------------------------------------------------ helpers

export function slugify(text: string) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/g, '-')
    .replace(/^-|-$/g, '');
}

const BASE = import.meta.env.BASE_URL.replace(/\/?$/, '/');
/** Site-relative link that works under the GitHub Pages sub-path. */
export const url = (path = '') => BASE + path.replace(/^\//, '');

export const media = {
  full: (image: string) => url(`media/full/${image}`),
  thumb: (image: string) => url(`media/thumb/${image}`),
};

export const youtubeThumb = (id: string, size: 'hq' | 'maxres' = 'hq') =>
  `https://i.ytimg.com/vi/${id}/${size}default.jpg`;

export const href = {
  artist: (id: string) => url(`artists/${id}/`),
  location: (id: string) => url(`locations/${id}/`),
  video: (id: string) => url(`videos/${id}/`),
  tag: (slug: string) => url(`tags/${slug}/`),
};

export const TYPE_LABEL: Record<string, string> = {
  mv: 'MV',
  performance: 'PERFORMANCE',
  live: 'LIVE',
  cover: 'COVER',
  clip: 'CLIP',
  other: 'VIDEO',
};

/** Short label for a video: the song name when known, else the full title. */
export const videoLabel = (v: Video) => v.data.song || v.data.title;

export function pinsFor(locations: Location[], count: (l: Location) => number): Pin[] {
  return locations
    .filter((l) => l.data.coordinates)
    .map((l) => ({
      id: l.id,
      name: l.data.name,
      lat: l.data.coordinates!.lat,
      lng: l.data.coordinates!.lng,
      count: count(l),
      href: href.location(l.id),
    }));
}

/** Stable pseudo-random order (same on every build) so "picks" don't churn the git history. */
export function stableShuffle<T extends { id: string }>(items: T[], seed = 'mv'): T[] {
  const h = (s: string) => {
    let x = 2166136261;
    for (const c of seed + s) x = Math.imul(x ^ c.charCodeAt(0), 16777619);
    return x >>> 0;
  };
  return [...items].sort((a, b) => h(a.id) - h(b.id));
}
