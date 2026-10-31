import { getCollection, type CollectionEntry } from 'astro:content';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseYoutubeId, slugify } from './ids';

export type Artist = CollectionEntry<'artists'>;
export type Location = CollectionEntry<'locations'>;
export type Video = CollectionEntry<'videos'>;

export interface Shot {
  image: string;
  set?: { id: string; name: string };
  /** For the lightbox caption; without href the name is shown as plain text (e.g. the page's own video). */
  video?: { label: string; href?: string };
  location?: { name: string; href?: string };
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

  // Studios ↔ their spaces (location "part_of"), also through several levels (Acres Space → Columbus Studio).
  const directSpaces = group(locations, (l) => (l.data.part_of ? [l.data.part_of.id] : []));
  const studiosOf = (id: string) =>
    walk(id, (x) => (locationById.get(x)?.data.part_of ? [locationById.get(x)!.data.part_of!.id] : [])).map(
      (x) => locationById.get(x)!,
    );
  const spacesOf = (id: string) =>
    walk(id, (x) => (directSpaces.get(x) ?? []).map((l) => l.id)).map((x) => locationById.get(x)!);

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

  // "Filmed together with" works both ways: listing it on one video is enough.
  const videoById = new Map(videos.map((v) => [v.id, v]));
  const relatedIds = new Map<string, Set<string>>();
  for (const v of videos) {
    for (const r of v.data.related ?? []) {
      for (const [a, b] of [[v.id, r.id], [r.id, v.id]]) {
        if (!relatedIds.has(a)) relatedIds.set(a, new Set());
        relatedIds.get(a)!.add(b);
      }
    }
  }

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
    /** The artist's own videos, then its members' and units' videos — each video once. */
    withMembers: (id: string) => {
      const seen = new Set<string>();
      return [id, ...membersOf(id).map((m) => m.id)]
        .flatMap((x) => videosByArtist.get(x) ?? [])
        .filter((v) => !seen.has(v.id) && (seen.add(v.id), true));
    },
    directMembers: (id: string) => directMembers.get(id) ?? [],
    /** Studios a location is part of, nearest first (space → Acres Space → Columbus Studio). */
    studiosOf,
    /** Spaces of a studio, at any depth. */
    spacesOf,
    directSpaces: (id: string) => directSpaces.get(id) ?? [],
    /** Videos filmed at this location or any of its spaces. */
    videoCount: (id: string) =>
      new Set([id, ...spacesOf(id).map((l) => l.id)].flatMap((x) => (appearancesByLocation.get(x) ?? []).map((a) => a.video.id)))
        .size,
    /** Videos filmed together with this one (either side of the link). */
    relatedTo: (id: string) => [...(relatedIds.get(id) ?? [])].map((r) => videoById.get(r)!).filter(Boolean),
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
  const videoIds = new Set(videos.map((v) => v.id));
  for (const v of videos) {
    if (v.data.platform === 'youtube' && !youtubeId(v))
      problems.push(`video "${v.id}": the Link "${v.data.url}" isn't a YouTube video address`);
    for (const r of v.data.related ?? []) {
      if (!videoIds.has(r.id)) problems.push(`video "${v.id}" is filmed together with "${r.id}", which doesn't exist`);
      if (r.id === v.id) problems.push(`video "${v.id}" is marked as filmed together with itself`);
    }
    for (const a of v.data.artists ?? [])
      if (!artistById.has(a.id)) problems.push(`video "${v.id}" uses artist "${a.id}", which doesn't exist`);
    for (const ap of v.data.appearances ?? []) {
      const location = locationById.get(ap.location.id);
      if (!location) {
        problems.push(`video "${v.id}" uses location "${ap.location.id}", which doesn't exist`);
        continue;
      }
      if (location.data.group_only)
        problems.push(`video "${v.id}" is linked to "${location.id}", which only groups places — pick one of its spaces`);
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
    const parent = l.data.part_of?.id;
    if (parent && !locationById.has(parent)) problems.push(`location "${l.id}" is part of "${parent}", which doesn't exist`);
    // Follow the "part of" chain upwards: coming back to the start means a loop (A part of B part of A).
    for (let x = parent, steps = 0; x && steps <= locations.length; x = locationById.get(x)?.data.part_of?.id, steps++) {
      if (x === l.id) {
        problems.push(`location "${l.id}" is (indirectly) part of itself`);
        break;
      }
    }
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

// Everything in content/ was created on this day by the one-shot migration; only later additions count as "new".
const MIGRATION_DATE = '2026-09-25';
let added: Map<string, string> | undefined;

/**
 * When each record was added ('content/videos/<id>.json' → 'YYYY-MM-DD'), from the git history: the admin
 * commits every new entry. A renamed id keeps its original date. Empty without git or in a shallow clone
 * (there every file would look added by the one commit there is) — the "new" lists then stay empty.
 */
export function addedDates(): Map<string, string> {
  if (added) return added;
  added = new Map();
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'core.quotepath=false', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (git('rev-parse', '--is-shallow-repository').trim() !== 'false') return added;
    const log = git('log', '--reverse', '-M', '--diff-filter=AR', '--name-status', '--format=%as', '--', 'content/videos', 'content/locations');
    let date = '';
    for (const line of log.split('\n')) {
      const [status, from, to] = line.trim().split('\t');
      if (/^\d{4}-\d{2}-\d{2}$/.test(status)) date = status;
      else if (status === 'A') added.set(from, date);
      else if (status?.startsWith('R') && to) {
        added.set(to, added.get(from) ?? date);
        added.delete(from);
      }
    }
  } catch {
    added.clear();
  }
  for (const [path, date] of added) if (date <= MIGRATION_DATE || !existsSync(path)) added.delete(path);
  return added;
}

export type Addition = { date: string } & ({ video: Video; location?: never } | { location: Location; video?: never });

/** Videos and locations added since the migration, newest first. */
export async function recentlyAdded(): Promise<Addition[]> {
  const data = await db();
  const dates = addedDates();
  const name = (a: Addition) => (a.video ? videoLabel(a.video) : a.location!.data.name);
  return [
    ...data.videos.flatMap((video) => {
      const date = dates.get(`content/videos/${video.id}.json`);
      return date ? [{ date, video }] : [];
    }),
    ...data.locations.flatMap((location) => {
      const date = dates.get(`content/locations/${location.id}.json`);
      return date ? [{ date, location }] : [];
    }),
  ].sort((a, b) => b.date.localeCompare(a.date) || collator.compare(name(a), name(b)));
}

// ------------------------------------------------------------------ helpers

export { slugify };

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

/**
 * The YouTube ID to play, read from the Link. The file name (video.id) is only the permanent page id:
 * when a video dies and is re-uploaded, the owner changes the Link and the page keeps its address.
 */
export const youtubeId = (v: Video) => parseYoutubeId(v.data.url);

export const youtubeThumb = (v: Video, size: 'hq' | 'maxres' = 'hq') =>
  `https://i.ytimg.com/vi/${youtubeId(v)}/${size}default.jpg`;

export const href = {
  artist: (id: string) => url(`artists/${id}/`),
  location: (id: string) => url(`locations/${id}/`),
  video: (id: string) => url(`videos/${id}/`),
  tag: (slug: string) => url(`tags/${slug}/`),
  year: (year: string | number) => url(`years/${year}/`),
};

/** Year of the YouTube upload ("2023"), or '' when the video has no date yet. */
export const videoYear = (v: Video) => v.data.published?.slice(0, 4) ?? '';

/** The grey line under a video card: its artists (else the channel), then the year if known. */
export const cardMeta = (v: Video, artistNames: string) =>
  [artistNames || v.data.channel, videoYear(v)].filter(Boolean).join(' · ') || ' ';

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
