// ID rules shared by the build (src/lib/data.ts) and the browser (the quick-add page): no Node imports here.

/** The 11-character YouTube ID in a watch / youtu.be / shorts / embed / live link. */
const YOUTUBE_ID = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;
export const parseYoutubeId = (link: string) => link.match(YOUTUBE_ID)?.[1];

/** Record id from a name: lowercase Latin letters, digits and Hangul, joined by hyphens (the admin's rule). */
export function slugify(text: string) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/g, '-')
    .replace(/^-|-$/g, '');
}
