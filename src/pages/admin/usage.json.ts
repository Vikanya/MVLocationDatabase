// For the admin page: who uses what, as of this build. Read by public/admin/artist-videos.js and admin/unused.
import { db, videoLabel } from '../../lib/data';

export async function GET() {
  const data = await db();
  const name = (a: { id: string; data: { name: string } }) => ({ id: a.id, name: a.data.name });
  const artists = Object.fromEntries(
    data.artists.map((artist) => [
      artist.id,
      {
        videos: data.byArtist(artist.id).map((v) => ({
          id: v.id,
          title: v.data.title,
          label: videoLabel(v),
          type: v.data.type ?? 'other',
          todo: (v.data.review ?? []).length,
          locations: data.ofVideo(v.id).map((a) => name(a.location)),
        })),
        members: data.directMembers(artist.id).map(name),
        groups: (artist.data.part_of ?? []).map((g) => name(data.artist(g.id)!)),
      },
    ]),
  );
  return new Response(JSON.stringify({ built: new Date().toISOString(), artists }));
}
