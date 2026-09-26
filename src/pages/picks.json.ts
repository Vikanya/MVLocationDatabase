// Every YouTube video as card data, for the home page's "Random picks" (shuffled in the browser on each visit).
import { db, href, videoLabel, videoLabelKo, youtubeThumb, TYPE_LABEL } from '../lib/data';

export async function GET() {
  const data = await db();
  const cards = data.videos
    .filter((v) => v.data.platform === 'youtube')
    .map((v) => {
      const kind = v.data.type ?? 'other';
      return {
        href: href.video(v.id),
        img: youtubeThumb(v),
        kind,
        badge: TYPE_LABEL[kind],
        label: videoLabel(v),
        ko: videoLabelKo(v),
        meta: data.videoArtists(v).map((a) => a.data.name).join(', ') || v.data.channel || ' ',
      };
    });
  return new Response(JSON.stringify(cards));
}
