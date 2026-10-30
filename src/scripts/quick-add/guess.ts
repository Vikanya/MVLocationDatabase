// Guesses for the quick-add form from a YouTube title: artists, songs, video type, coordinates.
// Pure functions (no DOM), tested with `node --test src/scripts/quick-add/`.

export interface ArtistRef {
  id: string;
  name: string;
  name_ko?: string;
}
export interface Song {
  title?: string;
  title_ko?: string;
}

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
export const hasHangul = (s = '') => HANGUL.test(s);
const norm = (s: string) => s.normalize('NFKC').toLowerCase();
const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/**
 * Existing artists named in the title or channel. Latin names must stand as whole words ("IVE" not in "LIVE"),
 * Hangul names may touch other text ("세븐틴" in "(세븐틴)"). Longest names first; a matched stretch is masked so
 * "A2O" doesn't also match inside "A2O MAY".
 */
export function matchArtists(title: string, channel: string, artists: ArtistRef[]): string[] {
  let text = norm(`${title} \u0000 ${channel}`);
  const names = artists
    .flatMap((a) => [a.name, a.name_ko].filter((n): n is string => !!n && n.trim().length >= 2).map((n) => ({ id: a.id, n: norm(n.trim()) })))
    .sort((a, b) => b.n.length - a.n.length);
  const found: string[] = [];
  for (const { id, n } of names) {
    for (let at = text.indexOf(n); at !== -1; at = text.indexOf(n, at + 1)) {
      const latin = !hasHangul(n);
      if (latin && (isWord(text[at - 1]) || isWord(text[at + n.length]))) continue;
      if (!found.includes(id)) found.push(id);
      text = text.slice(0, at) + '\u0000'.repeat(n.length) + text.slice(at + n.length);
    }
  }
  return found;
}

const QUOTES: [string[], string[]][] = [
  [["'", '‘', '’'], ["'", '’', '‘']],
  [['"', '“', '”'], ['"', '”', '“']],
  [['「', '『'], ['」', '』']],
];

/** The quoted part of a title ('…', ‘…’, "…", 「…」), from the first opening to the last closing quote. */
function quoted(title: string): string | undefined {
  let best: string | undefined;
  let bestAt = Infinity;
  for (const [open, close] of QUOTES) {
    const start = Math.min(...open.map((q) => title.indexOf(q)).filter((i) => i !== -1));
    if (!Number.isFinite(start) || start >= bestAt) continue;
    const end = Math.max(...close.map((q) => title.lastIndexOf(q)));
    if (end > start + 1) {
      best = title.slice(start + 1, end).trim();
      bestAt = start;
    }
  }
  return best || undefined;
}

/** "Artist - Song (…) Official MV" → "Song (…)": the text after a dash, before the kind of video. */
function dashed(title: string): string | undefined {
  const t = title.replace(/^\s*\[[^\]]*\]\s*/, '');
  const m = t.match(/\s[-_–|｜]\s*(.+)$/);
  if (!m) return undefined;
  const song = m[1]
    .split(/\s[|｜]\s|\s\[|#/)[0]
    .replace(/\s*(official\b.*|m\/v\b.*|\bmv\b.*|music video.*|performance.*|dance practice.*|live clip.*|special clip.*)$/i, '')
    .trim();
  return song || undefined;
}

const VERSION = /\b(ver|version|feat|ft|prod|remix|edit|cover)\b\.?/i;

/** Split "Main (Paren)" at the last bracketed part; a version note ("Boxers Ver.") is dropped. */
function split(seg: string): { main: string; paren?: string } {
  const m = seg.match(/^(.*?)\s*[(（]([^()（）]+)[)）]\s*$/);
  if (!m || !m[1].trim()) return { main: seg.trim() };
  if (VERSION.test(m[2])) return split(m[1].trim());
  return { main: m[1].trim(), paren: m[2].trim() };
}

/**
 * Song guess from the English title and the default (often Korean) title of the video: Latin title from the
 * Latin part, Korean title from the Hangul part. A bracketed part that both titles share is a subtitle and is
 * dropped ('Ridin' (CAN YOU HEAR THAT)' + '타! (CAN YOU HEAR THAT)' → Ridin' / 타!).
 */
export function guessSong(title: string, defaultTitle = title): Song | undefined {
  const parts = [title, defaultTitle].map((t) => {
    const seg = quoted(t) ?? dashed(t);
    return seg ? split(seg) : undefined;
  });
  const [en, def] = parts;
  if (!en && !def) return undefined;
  const song: Song = {};
  for (const p of [en, def]) {
    if (!p) continue;
    const shared = !!en?.paren && en.paren === def?.paren && en.main !== def?.main;
    const pieces = shared || !p.paren ? [p.main] : [p.main, p.paren];
    if (pieces.length === 2 && hasHangul(pieces[0]) === hasHangul(pieces[1])) pieces.splice(0, 2, `${p.main} (${p.paren})`);
    for (const piece of pieces) {
      if (hasHangul(piece)) song.title_ko ??= piece;
      else song.title ??= piece;
    }
  }
  return song.title || song.title_ko ? song : undefined;
}

export type VideoType = 'mv' | 'performance' | 'live' | 'cover' | 'clip' | 'other';

/** Video type from words in the title; MV when nothing else fits (the most common kind). */
export function guessType(title: string): VideoType {
  if (/\bcover(ed)?\b/i.test(title)) return 'cover';
  if (/\blive\b/i.test(title)) return 'live';
  if (/performance|dance practice|choreograph|안무|\bstage\b/i.test(title)) return 'performance';
  if (/special clip|track video|\bfilm\b|teaser|visualizer/i.test(title)) return 'clip';
  return 'mv';
}

/**
 * Latitude / longitude from what the owner pastes: "37.5157, 126.9015" (Google Maps right-click), or a full
 * Google Maps link (the place pin "!3d…!4d…" wins over the map centre "@…,…").
 */
export function parseCoordinates(text: string): { lat: number; lng: number } | undefined {
  const pick = (lat: string, lng: string) => {
    const c = { lat: Number(lat), lng: Number(lng) };
    return Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180 ? c : undefined;
  };
  const num = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const pin = text.match(new RegExp(`!3d${num}!4d${num}`));
  if (pin) return pick(pin[1], pin[2]);
  const at = text.match(new RegExp(`@${num},${num}`));
  if (at) return pick(at[1], at[2]);
  const q = text.match(new RegExp(`[?&](?:q|query|ll)=${num},\\s*${num}`));
  if (q) return pick(q[1], q[2]);
  const plain = text.trim().match(new RegExp(`^${num}\\s*,\\s*${num}$`));
  return plain ? pick(plain[1], plain[2]) : undefined;
}
