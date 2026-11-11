// The config both quick-add pages embed (src/pages/admin/add.astro, add-location.astro): repo, form order and
// kinds of place from public/admin/config.yml, and — under `astro dev` or a build with QUICK_ADD_MOCK=1 only —
// the local content/, so ?mock can stand in for GitHub without signing in (never in the deployed site).
import { readdirSync, readFileSync } from 'node:fs';
import { adminConfig } from './admin-config';
import { db, url, youtubeId } from './data';

const files = (dir: string, text = true) =>
  readdirSync(dir).map((name) => ({ name, text: text ? readFileSync(`${dir}/${name}`, 'utf8').replace(/\r\n/g, '\n') : '' }));

/** `videos`: the video page also needs the video files (mock) and the link-ID map. */
export async function quickAddConfig({ videos }: { videos: boolean }) {
  const config = adminConfig();
  const data = await db();
  // Videos whose Link no longer matches their file name (re-uploaded): link ID → file ID, for the duplicate check.
  const linkIds = videos
    ? Object.fromEntries(
        data.videos.flatMap((v) => {
          const y = youtubeId(v);
          return y && y !== v.id ? [[y, v.id]] : [];
        }),
      )
    : {};
  const mock =
    import.meta.env.DEV || process.env.QUICK_ADD_MOCK
      ? {
          snapshot: {
            head: 'mock',
            artists: files('content/artists'),
            locations: files('content/locations'),
            videos: readdirSync('content/videos'),
            media: readdirSync('public/media/full'),
          },
          videos: videos ? Object.fromEntries(files('content/videos').map((f) => [f.name, f.text])) : {},
        }
      : undefined;
  return {
    repo: config.repo,
    branch: config.branch,
    order: config.order,
    tags: config.tags,
    linkIds,
    youtubeKey: import.meta.env.PUBLIC_YOUTUBE_API_KEY ?? '',
    admin: url('admin/'),
    site: url(),
    mock,
  };
}

/** The config as a JSON script body (safe inside <script>). */
export const configJson = (page: unknown) => JSON.stringify(page).replace(/</g, '\\u003c');
