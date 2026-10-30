// What YouTube says about a video. With the Data API key (build env PUBLIC_YOUTUBE_API_KEY): English title,
// original title, channel, upload date, embeddable. Without it, or if the API fails: oEmbed (title + channel;
// an embedding-disabled video answers 401), no date.

export interface VideoInfo {
  /** English title when the uploader set one, else the original title. */
  title: string;
  /** The original title (often the Korean one) — used for the Korean song title. */
  originalTitle: string;
  channel: string;
  /** YYYY-MM-DD (UTC), only from the Data API. */
  published?: string;
  /** undefined = unknown */
  embeddable?: boolean;
  source: 'api' | 'oembed';
}

export class VideoNotFound extends Error {}

async function fromApi(id: string, key: string): Promise<VideoInfo> {
  const q = new URLSearchParams({ part: 'snippet,status', id, hl: 'en', key });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${q}`);
  if (!res.ok) throw new Error(`YouTube API ${res.status}`);
  const item = (await res.json()).items?.[0];
  if (!item) throw new VideoNotFound('YouTube doesn’t know this video (deleted or private?).');
  const s = item.snippet;
  return {
    title: s.localized?.title || s.title,
    originalTitle: s.title,
    channel: s.channelTitle,
    published: typeof s.publishedAt === 'string' ? s.publishedAt.slice(0, 10) : undefined,
    embeddable: item.status?.embeddable,
    source: 'api',
  };
}

async function fromOembed(id: string): Promise<VideoInfo> {
  const q = new URLSearchParams({ url: `https://www.youtube.com/watch?v=${id}`, format: 'json' });
  const res = await fetch(`https://www.youtube.com/oembed?${q}`);
  if (res.status === 401 || res.status === 403)
    return { title: '', originalTitle: '', channel: '', embeddable: false, source: 'oembed' };
  if (res.status === 404 || res.status === 400) throw new VideoNotFound('YouTube doesn’t know this video (deleted or private?).');
  if (!res.ok) throw new Error(`YouTube oEmbed ${res.status}`);
  const o = await res.json();
  return { title: o.title, originalTitle: o.title, channel: o.author_name, embeddable: true, source: 'oembed' };
}

export async function videoInfo(id: string, key?: string): Promise<VideoInfo> {
  if (key) {
    try {
      return await fromApi(id, key);
    } catch (e) {
      if (e instanceof VideoNotFound) throw e;
      console.warn('YouTube Data API failed, using oEmbed', e);
    }
  }
  return fromOembed(id);
}
