// For the quick-add page: what each location looks like, as of this build, so places and their sets can be
// recognised by picture rather than by name. Read by src/scripts/quick-add/catalogue.ts.
import { db, videoLabel } from '../../lib/data';

const SHOTS = 12;
const PER_SET = 4;
const file = (image: string) => image.split('/').pop()!;

export async function GET() {
  const data = await db();
  const locations = Object.fromEntries(
    data.locations.map((l) => {
      // A studio shows its spaces' screenshots too. Newest videos first; one screenshot per video before a second
      // one, so several shoots show up.
      const here = [l, ...data.spacesOf(l.id)]
        .flatMap((x) => data.atLocation(x.id))
        .sort((a, b) => (b.video.data.published ?? '').localeCompare(a.video.data.published ?? ''));
      const rounds = Math.max(0, ...here.map((a) => a.shots.length));
      const shots: { f: string; s?: string; v?: string }[] = (l.data.photos ?? []).map((p) => ({ f: file(p) }));
      for (let i = 0; i < rounds && shots.length < SHOTS; i++)
        for (const a of here)
          if (a.shots[i] && shots.length < SHOTS) shots.push({ f: file(a.shots[i].image), s: a.shots[i].set?.id, v: videoLabel(a.video) });
      const sets: Record<string, string[]> = {};
      for (const a of here.filter((x) => x.location.id === l.id))
        for (const s of a.shots)
          if (s.set && (sets[s.set.id] ??= []).length < PER_SET) sets[s.set.id].push(file(s.image));
      // Artists who filmed here (or in its spaces), most videos first.
      const artists = new Map<string, number>();
      for (const a of here) for (const r of a.video.data.artists ?? []) artists.set(r.id, (artists.get(r.id) ?? 0) + 1);
      return [
        l.id,
        {
          videos: data.videoCount(l.id),
          artists: [...artists].sort((a, b) => b[1] - a[1]).map(([id]) => id),
          shots,
          sets,
        },
      ];
    }),
  );
  return new Response(JSON.stringify({ built: new Date().toISOString(), locations }));
}
