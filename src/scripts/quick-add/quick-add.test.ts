// node --test src/scripts/quick-add/   (Node 24 runs TypeScript directly)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { adminConfig } from '../../lib/admin-config.ts';
import { parseYoutubeId, slugify } from '../../lib/ids.ts';
import { guessSong, guessType, matchArtists, parseCoordinates } from './guess.ts';
import { serialize } from './json.ts';

const config = adminConfig();
const read = (collection: string) =>
  readdirSync(`content/${collection}`).map((f) => {
    // The repo stores LF; a Windows checkout may have turned it into CRLF.
    const text = readFileSync(`content/${collection}/${f}`, 'utf8').replace(/\r\n/g, '\n');
    return { id: f.replace(/\.json$/, ''), text, data: JSON.parse(text) };
  });
const videos = read('videos');
const artists = read('artists').map((a) => ({ id: a.id, name: a.data.name, name_ko: a.data.name_ko }));

test('every content file is written back byte for byte', () => {
  for (const c of ['videos', 'locations', 'artists'] as const) {
    for (const f of read(c)) assert.equal(serialize(f.data, config.order[c], f.data), f.text, `${c}/${f.id}`);
  }
});

test('new keys go where the form puts them, empty fields are left out', () => {
  const before = { title: 'T', platform: 'youtube', url: 'u', type: 'mv' };
  const text = serialize({ ...before, channel: 'C', published: '2024-01-02', songs: [], start: undefined }, config.order.videos, before);
  assert.deepEqual(Object.keys(JSON.parse(text)), ['title', 'platform', 'url', 'published', 'type', 'channel']);
  const fresh = serialize({ embeddable: false, url: 'u', title: 'T', platform: 'youtube' }, config.order.videos);
  assert.deepEqual(Object.keys(JSON.parse(fresh)), ['title', 'platform', 'url', 'embeddable']);
});

test('kinds of place come from config.yml', () => {
  assert.ok(config.tags.includes('Helipad') && config.tags.length >= 20);
});

test('YouTube IDs and slugs', () => {
  assert.equal(parseYoutubeId('https://youtu.be/3bx6fS455sA?si=x'), '3bx6fS455sA');
  assert.equal(parseYoutubeId('https://www.youtube.com/watch?v=C3HDIYnQnkw&t=3'), 'C3HDIYnQnkw');
  assert.equal(parseYoutubeId('https://www.youtube.com/shorts/vi048osrhgw'), 'vi048osrhgw');
  assert.equal(parseYoutubeId('https://example.com/'), undefined);
  assert.equal(slugify('A2O MAY'), 'a2o-may');
  assert.equal(slugify('Abandoned factory #2'), 'abandoned-factory-2');
});

test('coordinates from a pasted pair or a Google Maps link', () => {
  assert.deepEqual(parseCoordinates('37.515725, 126.901538'), { lat: 37.515725, lng: 126.901538 });
  assert.deepEqual(
    parseCoordinates('https://www.google.com/maps/place/X/@37.51,126.90,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d37.5157!4d126.9015'),
    { lat: 37.5157, lng: 126.9015 },
  );
  assert.deepEqual(parseCoordinates('https://www.google.com/maps/@35.1,129.04,15z'), { lat: 35.1, lng: 129.04 });
  assert.equal(parseCoordinates('somewhere'), undefined);
});

test('artists named in titles', () => {
  assert.deepEqual(matchArtists("MODYSSEY 'Ridin' (CAN YOU HEAR THAT)' Official MV", 'MODYSSEY', artists), ['modyssey']);
  assert.ok(!matchArtists('[LIVE] something', '', artists).includes('ive'));
  // How often the guess equals the owner's artists over the whole database (informational, must stay useful).
  let same = 0;
  for (const v of videos) {
    const got = matchArtists(v.data.title, v.data.channel ?? '', artists).sort().join();
    if (got === [...(v.data.artists ?? [])].sort().join()) same++;
  }
  console.log(`artists guessed exactly: ${same}/${videos.length}`);
  assert.ok(same / videos.length > 0.6);
});

test('songs and types from titles', () => {
  assert.deepEqual(
    guessSong("MODYSSEY 'Ridin' (CAN YOU HEAR THAT)' Official MV", "MODYSSEY (모디세이) '타! (CAN YOU HEAR THAT)' Official MV"),
    { title: "Ridin'", title_ko: '타!' },
  );
  assert.deepEqual(guessSong("SEVENTEEN (세븐틴) '손오공' Official MV"), { title_ko: '손오공' });
  assert.deepEqual(guessSong('ATEEZ - ROCKY (Boxers Ver.) Official Music Video'), { title: 'ROCKY' });
  let songs = 0;
  let types = 0;
  for (const v of videos) {
    const want = v.data.songs?.[0];
    const got = guessSong(v.data.title);
    if (want && got && (got.title ?? '') === (want.title ?? '') && (got.title_ko ?? '') === (want.title_ko ?? '')) songs++;
    if (guessType(v.data.title) === (v.data.type ?? 'mv')) types++;
  }
  console.log(`first song guessed exactly: ${songs}/${videos.length} · type: ${types}/${videos.length}`);
  assert.ok(types / videos.length > 0.8);
});
