// What each location looks like (admin/locations.json, written by the site build): screenshots, a sample per
// set and who filmed there. Locations added since the last deploy simply have no entry.
export interface Look {
  videos: number;
  /** Artist ids, most videos first. */
  artists: string[];
  /** f = file in media/, s = set id, v = video label (none for the location's own photos). */
  shots: { f: string; s?: string; v?: string }[];
  sets: Record<string, string[]>;
}

let looks: Record<string, Look> = {};
let site = '';

export async function loadCatalogue(admin: string, siteRoot: string) {
  site = siteRoot;
  try {
    const res = await fetch(`${admin}locations.json`, { cache: 'no-store' });
    if (res.ok) looks = (await res.json()).locations ?? {};
  } catch {}
}

export const look = (id: string): Look | undefined => looks[id];
export const thumb = (f: string) => `${site}media/thumb/${f}`;
export const full = (f: string) => `${site}media/full/${f}`;
/** The picture that stands for a location: its first photo or screenshot. */
export const cover = (id: string) => looks[id]?.shots[0]?.f;
/** Thumbnails of screenshots uploaded since the last build don't exist yet: fall back to the full image. */
export function thumbFallback(e: Event) {
  const img = e.target as HTMLImageElement;
  const f = img.dataset.f;
  if (f && !img.src.endsWith(full(f))) img.src = full(f);
}
