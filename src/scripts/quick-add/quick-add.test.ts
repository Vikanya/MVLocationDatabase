// node --test src/scripts/quick-add/   (Node 24 runs TypeScript directly)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { adminConfig } from '../../lib/admin-config.ts';
import { parseYoutubeId, slugify } from '../../lib/ids.ts';
import { guessSong, guessType, matchArtists, parseCoordinates } from './guess.ts';
import { serialize } from './json.ts';
import {
  autoTick,
  coordsFromLink,
  editLocation,
  hasChanges,
  isShortMapsLink,
  locationJson,
  locationProblems,
  markDirty,
  newLocation,
  rebase,
  TODO_UNKNOWN,
} from './location-record.ts';

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

// ------------------------------------------------------------------ locations

const locs = read('locations');
const order = config.order.locations;
const open = (id: string) => {
  const f = locs.find((l) => l.id === id)!;
  return editLocation(id, f.text, 'sha');
};

test('an existing location opened and saved unchanged is byte-identical', () => {
  for (const f of locs) {
    const edit = editLocation(f.id, f.text, 'sha');
    assert.equal(hasChanges(edit), false, f.id);
    assert.equal(locationJson(edit, order), f.text, f.id);
  }
});

test('editing an existing location writes only what changed', () => {
  const unknown = locs.find((l) => l.data.status === 'unknown' && l.data.review?.includes(TODO_UNKNOWN))!;
  const edit = editLocation(unknown.id, unknown.text, 'sha');
  edit.status = 'identified';
  markDirty(edit, 'status');
  edit.coords = '37.5, 127.01';
  markDirty(edit, 'coords');
  autoTick(edit);
  assert.ok(edit.todos.find((t) => t.text === TODO_UNKNOWN)!.done);
  edit.sets.push({ id: 'roof', name: 'Roof', added: true });
  edit.photos.push('abcdef012345');
  edit.links.google_maps.push('https://maps.app.goo.gl/xyz');
  markDirty(edit, 'links.google_maps');
  const out = JSON.parse(locationJson(edit, order));
  assert.equal(out.status, 'identified');
  assert.deepEqual(out.coordinates, { lat: 37.5, lng: 127.01 });
  assert.equal(out.coordinates_source, 'google maps link');
  assert.ok(!(out.review ?? []).includes(TODO_UNKNOWN));
  assert.deepEqual(out.sets.at(-1), { id: 'roof', name: 'Roof' });
  assert.deepEqual(out.photos.at(-1), '/media/full/abcdef012345.webp');
  assert.deepEqual(out.sheet_rows, unknown.data.sheet_rows, 'fields the form does not know are kept');

  // Clearing the coordinates drops their source too.
  const withCoords = locs.find((l) => l.data.coordinates && l.data.coordinates_source)!;
  const e2 = editLocation(withCoords.id, withCoords.text, 'sha');
  e2.coords = '';
  markDirty(e2, 'coords');
  const o2 = JSON.parse(locationJson(e2, order));
  assert.equal(o2.coordinates, undefined);
  assert.equal(o2.coordinates_source, undefined);
});

test('an edit replayed on a newer file keeps the other side’s changes', () => {
  const f = locs.find((l) => l.data.address && !l.data.notes)!;
  const edit = editLocation(f.id, f.text, 'sha1');
  edit.notes = 'Rooftop closed in 2025';
  markDirty(edit, 'notes');
  edit.photos.push('111111111111');
  // Meanwhile the admin changed the address and added a set.
  const theirs = { ...f.data, address: 'New address 1', sets: [...(f.data.sets ?? []), { id: 'x', name: 'X' }] };
  const newer = rebase(edit, `${JSON.stringify(theirs, null, 2)}\n`, 'sha2');
  assert.equal(newer.base!.sha, 'sha2');
  assert.equal(newer.address, 'New address 1');
  const out = JSON.parse(locationJson(newer, order));
  assert.equal(out.address, 'New address 1');
  assert.equal(out.notes, 'Rooftop closed in 2025');
  assert.ok(out.sets.some((s: { id: string }) => s.id === 'x'));
  assert.ok(out.photos.includes('/media/full/111111111111.webp'));
});

test('a new location: form key order, links, coordinates from a full Maps link only', () => {
  const edit = newLocation('Sky Deck #2');
  assert.equal(edit.id, 'sky-deck-2');
  assert.equal(coordsFromLink(edit, 'https://maps.app.goo.gl/abc'), false);
  assert.ok(isShortMapsLink('https://maps.app.goo.gl/abc'));
  assert.equal(coordsFromLink(edit, 'https://www.google.com/maps/place/X/@1,2,17z/data=!3d37.5157!4d126.9015'), true);
  edit.links.google_maps = ['https://www.google.com/maps/place/X', ''];
  edit.links.website = ['https://example.com'];
  edit.address = ' Seoul ';
  edit.tags = ['Rooftop'];
  edit.sets = [{ id: 'a', name: 'A', added: true }, { id: '', name: '', added: true }];
  edit.photos = ['222222222222'];
  edit.newTodo = 'Check the address';
  const text = locationJson(edit, order);
  const out = JSON.parse(text);
  assert.deepEqual(Object.keys(out), ['review', 'name', 'status', 'address', 'coordinates', 'coordinates_source', 'links', 'photos', 'tags', 'sets']);
  assert.deepEqual(out.links, { google_maps: ['https://www.google.com/maps/place/X'], website: ['https://example.com'] });
  assert.equal(out.address, 'Seoul');
  assert.deepEqual(out.sets, [{ id: 'a', name: 'A' }]);
  assert.deepEqual(locationProblems(edit, false), []);
  assert.equal(locationProblems(edit, true).length, 1);
  edit.coords = 'nowhere';
  assert.match(locationProblems(edit, false)[0], /not understood/);
  assert.ok(open(locs[0].id).base);
});
