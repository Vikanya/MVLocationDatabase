// Every artist, video and location as compact entries, for the sidebar quick-find and the random buttons.
// t = type (l/a/v), n = name, ko = Korean name, x = extra text to match (address + id for places, never shown), h = link.
import { byName, db, href, videoLabel, videoLabelKo } from '../lib/data';

export async function GET() {
  const data = await db();
  const places = data.locations.map((l) => ({
    t: 'l',
    n: l.data.name,
    // The id is often the Latin name of a place listed under its Korean name (ametage-studio = 아메티지 스튜디오).
    x: [l.data.address, l.id.replace(/-/g, ' ')].filter(Boolean).join(' '),
    h: href.location(l.id),
    s: data.atLocation(l.id).some((a) => a.shots.length > 0) || (l.data.photos?.length ?? 0) > 0 ? 1 : 0,
    c: data.videoCount(l.id),
  }));
  const artists = data.artists.map((a) => ({
    t: 'a',
    n: a.data.name,
    ko: a.data.name_ko,
    x: data.groupsOf(a.id).map((g) => g.data.name).join(', ') || undefined,
    h: href.artist(a.id),
    c: data.withMembers(a.id).length,
  }));
  const videos = data.videos
    .map((v) => ({
      t: 'v',
      n: videoLabel(v),
      ko: videoLabelKo(v) || undefined,
      x: v.data.title,
      k: v.data.type ?? 'other',
      h: href.video(v.id),
      m: data.videoArtists(v).map((a) => a.data.name).join(', ') || v.data.channel || '',
    }))
    .sort((a, b) => byName({ data: { name: a.n } }, { data: { name: b.n } }));
  return new Response(JSON.stringify([...places, ...artists, ...videos]));
}
