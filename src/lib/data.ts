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
  checkReferences(artists, locations, videos, artistById, locationById);

  // Groups ↔ members / sub-units ("part_of"), followed through several levels.
  const directMembers = group(artists, (a) => (a.data.part_of ?? []).map((g) => g.id));
  const walk = (id: string, next: (id: string) => string[], seen = new Set<string>()): string[] => {
    for (const n of next(id)) if (!seen.has(n)) (seen.add(n), walk(n, next, seen));
    return [...seen];
  };
  const groupsOf = (id: string) =>
    walk(id, (x) => (artistById.get(x)?.data.part_of ?? []).map((g) => g.id)).map((x) => artistById.get(x)!);
  const membersOf = (id: string) =>
    walk(id, (x) => (directMembers.get(x) ?? []).map((m) => m.id)).map((x) => artistById.get(x)!);

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
    /** Videos tagged with exactly this artist. */
    byArtist: (id: string) => videosByArtist.get(id) ?? [],
    /** Groups the artist is part of, nearest first (member → unit → group). */
    groupsOf,
    /** Members and sub-units of a group, at any depth. */
    membersOf,
    directMembers: (id: string) => directMembers.get(id) ?? [],
  };
}

/**
 * Fail the build with a readable list when a record points to something that doesn't exist
 * (e.g. an artist deleted in the admin while videos still use it). The live site then stays as it was.
 */
function checkReferences(
  artists: Artist[],
  locations: Location[],
  videos: Video[],
  artistById: Map<string, Artist>,
  locationById: Map<string, Location>,
) {
  const problems: string[] = [];
  for (const v of videos) {
    for (const a of v.data.artists ?? [])
      if (!artistById.has(a.id)) problems.push(`video "${v.id}" uses artist "${a.id}", which doesn't exist`);
    for (const ap of v.data.appearances ?? []) {
      const location = locationById.get(ap.location.id);
      if (!location) {
        problems.push(`video "${v.id}" uses location "${ap.location.id}", which doesn't exist`);
        continue;
      }
      const sets = new Set((location.data.sets ?? []).map((s) => s.id));
      for (const s of ap.screenshots ?? [])
        if (s.set && !sets.has(s.set))
          problems.push(`video "${v.id}": set "${s.set}" isn't one of the sets of location "${location.id}"`);
    }
  }
  for (const a of artists) {
    for (const g of a.data.part_of ?? []) {
      if (!artistById.has(g.id)) problems.push(`artist "${a.id}" is part of "${g.id}", which doesn't exist`);
      if (g.id === a.id) problems.push(`artist "${a.id}" is marked as part of itself`);
    }
  }
  for (const l of locations) {
    const ids = (l.data.sets ?? []).map((s) => s.id);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length) problems.push(`location "${l.id}" has the set id "${dup[0]}" twice`);
  }
  if (problems.length) {
    throw new Error(`Broken references in content/ (fix them in the admin page):\n  - ${problems.join('\n  - ')}`);
  }
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

// Images are stored as the CMS writes them ("/media/full/abc.webp"); only the file name matters here.
// Thumbnails for newly uploaded screenshots are generated at build time (scripts/thumbnails.mjs).
const fileName = (image: string) => image.split('/').pop()!;
export const media = {
  full: (image: string) => url(`media/full/${fileName(image)}`),
  thumb: (image: string) => url(`media/thumb/${fileName(image)}`),
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

const songs = (v: Video) => v.data.songs ?? [];
/** Short label for a video: its songs ("Glow up + LOVE ATTACK"), Latin titles first; else the video title. */
export const videoLabel = (v: Video) =>
  songs(v).map((s) => s.title || s.title_ko).join(' + ') || v.data.title;
/** The Korean titles to show next to the label — only when every song has both a Latin and a Korean title. */
export const videoLabelKo = (v: Video) =>
  songs(v).length > 0 && songs(v).every((s) => s.title && s.title_ko) ? songs(v).map((s) => s.title_ko).join(' + ') : '';

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
