// The video quick-add form (src/pages/admin/add.astro). One state object, kept as a draft in IndexedDB; sections
// are redrawn when their structure changes, text fields only update the state (so typing never loses focus).
// Locations can be created or edited inline with the shared editor (location-form.ts).
import { parseYoutubeId, slugify } from '../../lib/ids.ts';
import { look } from './catalogue.ts';
import { $, chip, doneBox, field, fill, flash, guessBadge, h, onEdited, searchBox, textInput, thumbImg } from './dom.ts';
import { draftStore } from './draft.ts';
import { ConflictError, MissingBlobError, type Change } from './github.ts';
import { guessSong, guessType, hasHangul, matchArtists, parseCoordinates, type Song, type VideoType } from './guess.ts';
import { imagesFrom } from './images.ts';
import { serialize } from './json.ts';
import { locationEditor } from './location-form.ts';
import { editLocation, hasChanges, locationJson, locationProblems, newLocation, rebase, type LocationEdit } from './location-record.ts';
import { browseState, catalogue, locationCard, locationOption, reference } from './picker.ts';
import { artistOf, branch, cfg, connect, locationOf, params, remember, setsOf, spacesOf, store, takenArtist, takenLocation } from './store.ts';
import {
  blobOf,
  encode,
  imageTile,
  markTarget,
  paintAll,
  pasteTarget,
  pump,
  resendAll,
  resetUploads,
  setPasteTarget,
  setupUploads,
  track,
  uploaded,
  uploadProblem,
} from './uploads.ts';
import { VideoNotFound, videoInfo, type VideoInfo } from './youtube.ts';

interface Shot {
  hash: string;
  set?: string;
}
interface Appearance {
  location: string;
  /** The key of the new location this appearance created (its id follows the name as it's typed). */
  edit?: string;
  shots: Shot[];
}
interface NewArtist {
  id: string;
  name: string;
  name_ko: string;
  part_of: string[];
}
interface State {
  link: string;
  id?: string;
  /** The video file when it's already in the database: its name, text and blob sha. */
  existing?: { file: string; text: string; sha: string };
  info?: VideoInfo;
  title: string;
  published: string;
  channel: string;
  embeddable: boolean;
  type: VideoType;
  songs: Song[];
  artists: string[];
  newArtists: NewArtist[];
  appearances: Appearance[];
  /** Locations created or opened for editing on this page. */
  locationEdits: LocationEdit[];
  /** Existing video: which missing fields to fill from YouTube. */
  fill: Record<string, boolean>;
  guessed: { artists: boolean; songs: boolean; type: boolean };
}

const fresh = (): State => ({
  link: '',
  title: '',
  published: '',
  channel: '',
  embeddable: true,
  type: 'mv',
  songs: [],
  artists: [],
  newArtists: [],
  appearances: [],
  locationEdits: [],
  fill: {},
  guessed: { artists: false, songs: false, type: false },
});

// ------------------------------------------------------------------ state

const draft = draftStore('quick-add');
let state = fresh();
let saving = false;
const browse = browseState();
/** Locations whose "what it looks like" strip was folded away. */
const refClosed = new Set<string>();

store.edits = () => state.locationEdits;
const allShots = () => state.appearances.flatMap((a) => a.shots);
setupUploads({ draft, images: () => [...allShots().map((s) => s.hash), ...state.locationEdits.flatMap((e) => e.photos)], changed: () => renderSave() });

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => draft.save(state), 300);
}
onEdited(() => (renderSave(), persist()));
/** After a structural change: redraw what depends on it and keep the draft. */
function changed(...parts: ('video' | 'artists' | 'locations')[]) {
  if (parts.includes('video')) renderVideo();
  if (parts.includes('artists')) renderArtists();
  // The locations follow the artists too ("where these artists filmed before").
  if (parts.includes('locations') || parts.includes('artists')) renderLocations();
  renderSave();
  persist();
}

/** The editor of an appearance's location, if it's new or opened for editing. */
const editOf = (ap: Appearance) => state.locationEdits.find((e) => (ap.edit ? e.key === ap.edit : !!e.base && e.id === ap.location));

// ------------------------------------------------------------------ images

async function addFiles(files: File[]) {
  const t = pasteTarget();
  if (t.startsWith('photos:')) return addPhotos(t.slice(7), files);
  return addShots(files, Number(t.slice(6)) || 0);
}

async function addShots(files: File[], to: number) {
  const ap = state.appearances[to];
  if (!ap) return flash('Add a filming location first, then paste the screenshots into it.');
  setPasteTarget(`shots:${to}`);
  for (const file of files) {
    try {
      const hash = await encode(file);
      if (ap.shots.some((s) => s.hash === hash)) continue;
      const sets = setsOf(ap.location);
      ap.shots.push({ hash, set: sets.length === 1 ? sets[0].id : undefined });
      changed('locations');
      await track(hash);
    } catch (e) {
      flash((e as Error).message);
    }
  }
}

async function addPhotos(key: string, files: File[]) {
  const edit = state.locationEdits.find((e) => e.key === key);
  if (!edit) return;
  for (const file of files) {
    try {
      const hash = await encode(file);
      if (edit.photos.includes(hash)) continue;
      edit.photos.push(hash);
      changed('locations');
      await track(hash);
    } catch (e) {
      flash((e as Error).message);
    }
  }
}

// ------------------------------------------------------------------ lookups

const artistName = (id: string) => {
  const a = artistOf(id) ?? state.newArtists.find((x) => x.id === id);
  return a ? [a.name, a.name_ko].filter(Boolean).join(' ') : id;
};
/** The artists of the video being added (with their groups), for "filmed here before". */
function videoArtists(): Set<string> {
  const ids: string[] = state.existing ? (JSON.parse(state.existing.text).artists ?? []) : state.artists;
  return new Set(ids.flatMap((id) => [id, ...(artistOf(id)?.part_of ?? [])]));
}

// ------------------------------------------------------------------ link → video info

async function loadLink(link: string, keepDraft = false) {
  const status = $('qa-link-status');
  const id = parseYoutubeId(link);
  state = { ...fresh(), link };
  $('qa-result').replaceChildren();
  if (!keepDraft) $('qa-draft').replaceChildren(); // a new link replaces the saved draft
  if (!id) {
    status.textContent = link.trim() ? 'That isn’t a YouTube video link.' : '';
    return changed('video', 'artists', 'locations');
  }
  const snap = store.snap;
  if (!snap) return;
  status.textContent = 'Looking it up…';
  const file = snap.videos.includes(`${id}.json`) ? id : cfg.linkIds[id];
  const clash = !file && snap.videos.find((n) => n.toLowerCase() === `${id}.json`.toLowerCase());
  if (clash) {
    status.textContent = `Another video (${clash.replace(/\.json$/, '')}) has the same ID apart from upper/lower case — Windows can’t store both. Add this one in the admin with a different ID.`;
    return changed('video', 'artists', 'locations');
  }
  try {
    const [info, existing] = await Promise.all([
      videoInfo(id, cfg.youtubeKey).catch((e) => (file ? undefined : Promise.reject(e))),
      file ? store.repo!.file(`content/videos/${file}.json`) : Promise.resolve(undefined),
    ]);
    if (state.link !== link) return; // a newer link was pasted meanwhile
    state.id = file ?? id;
    state.info = info;
    if (file && existing) {
      state.existing = { file: `${file}.json`, text: existing.text, sha: existing.sha };
      const data = JSON.parse(existing.text);
      for (const [k, v] of Object.entries({ title: info?.title, published: info?.published, channel: info?.channel, embeddable: info?.embeddable }))
        if (v !== undefined && v !== '' && data[k] === undefined) state.fill[k] = true;
      status.textContent = `Already in the database${file !== id ? ` (as ${file})` : ''} — you can add screenshots or another filming location.`;
    } else if (info) {
      state.title = info.title;
      state.published = info.published ?? '';
      state.channel = info.channel;
      state.embeddable = info.embeddable ?? true;
      state.type = guessType(info.title);
      state.artists = matchArtists(`${info.title} ${info.originalTitle}`, info.channel, store.artists);
      const song = guessSong(info.title, info.originalTitle);
      state.songs = song ? [song] : [];
      state.guessed = { artists: state.artists.length > 0, songs: !!song, type: true };
      status.textContent =
        info.source === 'api'
          ? 'Found on YouTube.'
          : info.title
            ? 'Found on YouTube (no API key here, so the published date is empty).'
            : 'YouTube doesn’t allow embedding this video, so its details can’t be read without the API key — fill them in.';
    }
  } catch (e) {
    status.textContent = e instanceof VideoNotFound ? e.message : `Couldn’t reach YouTube: ${(e as Error).message}`;
  }
  setPasteTarget('shots:0');
  changed('video', 'artists', 'locations');
}

// ------------------------------------------------------------------ sections

function renderVideo() {
  const box = $('qa-video');
  $('qa-rest').hidden = !state.id;
  $('qa-savebar').hidden = !state.id;
  if (!state.id) return box.replaceChildren();
  const yt = h('a', { href: `https://www.youtube.com/watch?v=${parseYoutubeId(state.link)}`, target: '_blank', rel: 'noopener' }, 'open on YouTube ↗');

  if (state.existing) {
    const data = JSON.parse(state.existing.text);
    const missing = Object.keys(state.fill);
    return fill(box,
      h('p', {}, h('b', {}, data.title), ' · ', yt, ' · ', h('a', { href: `${cfg.admin}#/collections/videos/entries/${encodeURIComponent(state.id)}`, target: '_blank', rel: 'noopener' }, '✎ edit in the admin')),
      missing.length
        ? h(
            'div',
            { class: 'qa-fill' },
            h('p', { class: 'qa-note' }, 'Missing on this video — add from YouTube:'),
            missing.map((k) =>
              h(
                'label',
                { class: 'qa-check' },
                h('input', { type: 'checkbox', checked: state.fill[k], onchange: (e: Event) => ((state.fill[k] = (e.target as HTMLInputElement).checked), changed()) }),
                ` ${k}: `,
                h('b', {}, String(state.info?.[k as keyof VideoInfo])),
              ),
            ),
          )
        : null,
    );
  }

  const types: [VideoType, string][] = [['mv', 'MV'], ['performance', 'Performance'], ['live', 'Live'], ['cover', 'Cover'], ['clip', 'Clip / special'], ['other', 'Other']];
  const songRows = h('div', { class: 'qa-songs' });
  const drawSongs = () =>
    songRows.replaceChildren(
      ...state.songs.map((s, i) =>
        h(
          'div',
          { class: 'qa-row' },
          textInput(s.title ?? '', (v) => (s.title = v), { placeholder: 'Latin title (e.g. Go Up)' }),
          textInput(s.title_ko ?? '', (v) => (s.title_ko = v), { placeholder: 'Korean title (e.g. 위로위로)', lang: 'ko' }),
          h('button', { class: 'btn', type: 'button', title: 'Remove', onclick: () => (state.songs.splice(i, 1), drawSongs(), changed()) }, '×'),
        ),
      ),
      h('button', { class: 'btn', type: 'button', onclick: () => (state.songs.push({}), drawSongs(), changed()) }, '+ SONG'),
    );
  drawSongs();

  fill(box,
    h('p', { class: 'qa-note' }, yt, state.channel ? ` · channel: ${state.channel}` : ''),
    field('Title', textInput(state.title, (v) => (state.title = v)), 'As on YouTube. The English title when the label set one.'),
    h(
      'div',
      { class: 'qa-row' },
      field(
        'Published',
        h('input', { type: 'date', value: state.published, oninput: (e: Event) => ((state.published = (e.target as HTMLInputElement).value), persist()) }),
      ),
      field(
        'Type',
        h(
          'select',
          { onchange: (e: Event) => ((state.type = (e.target as HTMLSelectElement).value as VideoType), (state.guessed.type = false), changed('video')) },
          types.map(([v, l]) => h('option', { value: v, selected: v === state.type }, l)),
        ),
        guessBadge(state.guessed.type, 'GUESSED'),
      ),
      h(
        'label',
        { class: 'qa-check' },
        h('input', { type: 'checkbox', checked: state.embeddable, onchange: (e: Event) => ((state.embeddable = (e.target as HTMLInputElement).checked), persist()) }),
        ' Can be played on the site',
      ),
    ),
    h('div', { class: 'qa-field' }, h('span', {}, 'Songs ', guessBadge(state.guessed.songs)), songRows),
  );
}

function renderArtists() {
  const box = $('qa-artists');
  // An existing video's artists are edited in the admin.
  $('qa-artists-win').hidden = !!state.existing;
  if (!state.id || state.existing) return box.replaceChildren();
  const options = () =>
    store.artists.filter((a) => !state.artists.includes(a.id)).map((a) => ({ id: a.id, label: a.name, sub: a.name_ko }));
  // A new artist's chip follows its name as it's typed.
  const labels = new Map(state.artists.map((id) => [id, h('span', {}, artistName(id))]));
  fill(box,
    h(
      'ul',
      { class: 'chips qa-chips' },
      state.artists.map((id, i) =>
        chip(
          labels.get(id),
          () => {
            // By position: a new artist's id changes while its name is typed.
            const [gone] = state.artists.splice(i, 1);
            state.newArtists = state.newArtists.filter((x) => x.id !== gone);
            state.guessed.artists = false;
            changed('artists');
          },
          state.newArtists.some((a) => a.id === id) ? h('span', { class: 'badge' }, 'NEW') : null,
        ),
      ),
    ),
    guessBadge(state.guessed.artists, 'MATCHED FROM THE TITLE — CHECK'),
    searchBox({
      placeholder: 'Add an artist…',
      options,
      pick: (id) => (state.artists.push(id), changed('artists')),
      createLabel: '+ New artist',
      create: (text) => {
        const ko = hasHangul(text) && !/[a-z]/i.test(text);
        const a: NewArtist = { id: '', name: ko ? '' : text, name_ko: ko ? text : '', part_of: [] };
        a.id = slugify(a.name || a.name_ko);
        state.newArtists.push(a);
        state.artists.push(a.id);
        changed('artists');
      },
    }),
    state.newArtists.map((a) => newArtistForm(a, labels.get(a.id))),
  );
}

function newArtistForm(a: NewArtist, label?: HTMLElement) {
  const idNote = h('small', { class: 'muted' });
  const showId = () => {
    idNote.textContent = takenArtist(a.id) ? `✕ The id “${a.id}” is taken — pick that artist instead, or change the name.` : `Page: …/artists/${a.id || '?'}/`;
    idNote.dataset.tone = takenArtist(a.id) || !a.id ? 'error' : '';
  };
  showId();
  // The id comes from the Latin name, else from the Korean one.
  const reslug = () => {
    const old = a.id;
    a.id = slugify(a.name || a.name_ko);
    state.artists = state.artists.map((x) => (x === old ? a.id : x));
    if (label) label.textContent = [a.name, a.name_ko].filter(Boolean).join(' ') || '(new artist)';
    showId();
  };
  return h(
    'fieldset',
    { class: 'qa-new' },
    h('legend', {}, 'New artist'),
    h(
      'div',
      { class: 'qa-row' },
      field('Name (Latin)', textInput(a.name, (v) => ((a.name = v), reslug()))),
      field('Name (Korean)', textInput(a.name_ko, (v) => ((a.name_ko = v), reslug()), { lang: 'ko' })),
    ),
    idNote,
    h(
      'div',
      { class: 'qa-field' },
      h('span', {}, 'Part of (for a member or sub-unit)'),
      h('ul', { class: 'chips' }, a.part_of.map((g) => chip(artistName(g), () => ((a.part_of = a.part_of.filter((x) => x !== g)), changed('artists'))))),
      searchBox({
        placeholder: 'Group…',
        options: () => store.artists.filter((x) => !a.part_of.includes(x.id)).map((x) => ({ id: x.id, label: x.name, sub: x.name_ko })),
        pick: (id) => (a.part_of.push(id), changed('artists')),
      }),
    ),
  );
}

function renderLocations() {
  const box = $('qa-locations');
  if (!state.id) return box.replaceChildren();
  const existingAps: { location: string; screenshots?: unknown[] }[] = state.existing ? (JSON.parse(state.existing.text).appearances ?? []) : [];
  const used = new Set(state.appearances.map((a) => a.location));
  const options = () => store.locations.filter((l) => !used.has(l.id)).map(locationOption);
  const startAppearance = (location: string, edit?: string) => {
    state.appearances.push({ location, edit, shots: [] });
    setPasteTarget(`shots:${state.appearances.length - 1}`);
    browse.open = false;
    browse.within = '';
    changed('locations');
  };
  // A studio or area opens the pictures of its spaces instead (a "groups only" studio can't be picked itself).
  const pickLocation = (id: string) => {
    if (!spacesOf(id).length) return startAppearance(id);
    Object.assign(browse, { open: true, within: id, query: '', tag: '' });
    renderLocations();
    document.querySelector('.qa-cat')?.scrollIntoView({ block: 'nearest' });
  };
  // Existing video: its filming locations are offered first.
  const offer = existingAps.filter((a) => !used.has(a.location));
  // Places where this video's artists (or their groups) filmed before.
  const mine = videoArtists();
  const before = store.locations
    .filter((l) => !used.has(l.id) && !l.group_only && !offer.some((a) => a.location === l.id) && look(l.id)?.artists.some((a) => mine.has(a)))
    .sort((a, b) => look(b.id)!.videos - look(a.id)!.videos)
    .slice(0, 8);
  fill(box,
    ...state.appearances.map((ap, i) => appearanceBlock(ap, i, existingAps.find((e) => e.location === ap.location)?.screenshots?.length)),
    offer.length
      ? h(
          'p',
          { class: 'qa-note' },
          'Add screenshots to: ',
          offer.map((a) => h('button', { class: 'btn', type: 'button', onclick: () => startAppearance(a.location) }, `${locationOf(a.location)?.name ?? a.location} (${a.screenshots?.length ?? 0})`)),
        )
      : null,
    before.length
      ? h(
          'div',
          { class: 'qa-field' },
          h('span', {}, 'Where these artists filmed before'),
          h('div', { class: 'qa-sugs' }, before.map((l) => locationCard(l, pickLocation, undefined, true))),
        )
      : null,
    h(
      'div',
      { class: 'qa-row qa-loc-find' },
      searchBox({
        placeholder: state.appearances.length ? 'Another filming location… (name, area, kind, artist)' : 'Filming location… (name, area, kind, artist)',
        options,
        pick: pickLocation,
        createLabel: '+ New location',
        create: (text) => {
          const edit = newLocation(text);
          state.locationEdits.push(edit);
          startAppearance(edit.id, edit.key);
        },
      }),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          'aria-pressed': String(browse.open),
          onclick: () => (Object.assign(browse, { open: !browse.open, within: '' }), renderLocations()),
        },
        browse.open ? 'HIDE PICTURES' : '▦ BROWSE BY PICTURE',
      ),
    ),
    browse.open ? catalogue({ browse, used, open: pickLocation, pick: (id) => startAppearance(id), back: () => ((browse.within = ''), renderLocations()) }) : null,
  );
  markTarget();
  paintAll();
}

/** Open an existing location's editor inside its filming-location block. */
async function openEdit(id: string) {
  const file = await store.repo!.file(`content/locations/${id}.json`).catch((e: Error) => flash(`Couldn’t read ${id}: ${e.message}`));
  if (!file) return;
  if (!state.locationEdits.some((e) => e.base && e.id === id)) state.locationEdits.push(editLocation(id, file.text, file.sha));
  changed('locations');
}
function closeEdit(edit: LocationEdit) {
  if (hasChanges(edit) && !confirm(`Drop your changes to ${edit.name || edit.id}?`)) return;
  state.locationEdits = state.locationEdits.filter((e) => e !== edit);
  changed('locations');
}

function appearanceBlock(ap: Appearance, i: number, before?: number) {
  const edit = editOf(ap);
  const loc = locationOf(ap.location);
  const heading = h('b', {}, loc?.name || ap.location || '(new location)');
  const picker = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (e: Event) => addShots([...((e.target as HTMLInputElement).files ?? [])], i) });
  const block = h(
    'section',
    {
      class: 'qa-ap',
      'data-target': `shots:${i}`,
      onclick: () => pasteTarget() !== `shots:${i}` && setPasteTarget(`shots:${i}`),
      ondragover: (e: DragEvent) => (e.preventDefault(), block.classList.add('qa-drop')),
      ondragleave: () => block.classList.remove('qa-drop'),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        block.classList.remove('qa-drop');
        addShots(imagesFrom(e.dataTransfer), i);
      },
    },
    h(
      'header',
      { class: 'qa-ap-head' },
      heading,
      edit && !edit.base ? h('span', { class: 'badge' }, 'NEW') : null,
      edit?.base ? h('span', { class: 'badge' }, 'EDITING') : null,
      before !== undefined ? h('span', { class: 'muted' }, `${before} screenshot${before === 1 ? '' : 's'} already`) : null,
      h('span', { class: 'qa-grow' }),
      h('button', { class: 'btn', type: 'button', onclick: () => picker.click() }, '+ PICK FILES'),
      !edit
        ? h('button', { class: 'btn', type: 'button', title: 'Sets, coordinates, address, links, photos, to-dos — saved with the video', onclick: () => openEdit(ap.location) }, '✎ EDIT LOCATION')
        : edit.base
          ? h('button', { class: 'btn', type: 'button', onclick: () => closeEdit(edit) }, 'CLOSE EDIT')
          : null,
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          title: 'Remove this filming location',
          onclick: (e: Event) => {
            e.stopPropagation();
            if (ap.shots.length && !confirm(`Remove ${loc?.name ?? ap.location} and its ${ap.shots.length} new screenshot(s)?`)) return;
            state.appearances.splice(i, 1);
            if (edit) state.locationEdits = state.locationEdits.filter((x) => x !== edit);
            const t = Number(pasteTarget().slice(6)) || 0;
            setPasteTarget(`shots:${Math.max(0, Math.min(t, state.appearances.length - 1))}`);
            changed('locations');
          },
        },
        '×',
      ),
      picker,
    ),
    edit
      ? locationEditor(edit, {
          compact: true,
          redraw: () => changed('locations'),
          idChanged: (_old, now) => (ap.location = now),
          named: (v) => (heading.textContent = v || '(new location)'),
          setChanged: (old, now) => {
            for (const s of ap.shots) if (s.set === old) s.set = now;
          },
          addPhotos: (files) => addPhotos(edit.key, files),
          removePhoto: (hash) => ((edit.photos = edit.photos.filter((x) => x !== hash)), changed('locations')),
        })
      : null,
    edit && !edit.base ? null : reference(ap.location, refClosed),
    h(
      'div',
      { class: 'qa-tiles' },
      ap.shots.map((s, j) => shotTile(ap, s, j)),
      h('div', { class: 'qa-paste' }, 'Ctrl+V pastes screenshots into the highlighted location · drop images here'),
    ),
  );
  return block;
}

function shotTile(ap: Appearance, s: Shot, j: number) {
  const sets = setsOf(ap.location);
  const samples = look(ap.location)?.sets ?? {};
  return imageTile(
    s.hash,
    () => (ap.shots.splice(j, 1), changed('locations')),
    sets.length
      ? h(
          'div',
          { class: 'qa-sets' },
          sets.map((set) =>
            h(
              'button',
              {
                type: 'button',
                class: 'qa-pill',
                'aria-pressed': String(s.set === set.id),
                onclick: () => ((s.set = s.set === set.id ? undefined : set.id), changed('locations')),
              },
              samples[set.id]?.[0] ? thumbImg(samples[set.id][0], { class: 'qa-pill-img' }) : null,
              set.name,
            ),
          ),
        )
      : null,
  );
}

// ------------------------------------------------------------------ save

/** What can't be saved yet, in words (empty = ready). */
function problems(): string[] {
  const p: string[] = [];
  if (!state.id) return ['Paste a YouTube link.'];
  if (!state.existing && !state.title.trim()) p.push('The video needs a title.');
  for (const a of state.newArtists) {
    if (!a.id) p.push('A new artist needs a name.');
    else if (takenArtist(a.id)) p.push(`The artist id “${a.id}” is taken.`);
  }
  for (const e of state.locationEdits) p.push(...locationProblems(e, takenLocation(e)));
  if (state.existing && !allShots().length && !Object.values(state.fill).some(Boolean) && !state.locationEdits.some(hasChanges))
    p.push('Nothing to add yet: paste screenshots.');
  const up = uploadProblem();
  if (up) p.push(up);
  return p;
}

function renderSave() {
  const button = $('qa-save') as HTMLButtonElement;
  const status = $('qa-save-status');
  if (saving) return;
  const p = problems();
  button.disabled = p.length > 0;
  status.textContent = p.length ? p.join(' ') : `Ready: one commit to ${cfg.repo} (${branch}).`;
  status.dataset.tone = '';
}

function changes(): { files: Change[]; message: string } {
  const id = state.id!;
  const shots = (ap: Appearance) => ap.shots.map((s) => ({ image: `/media/full/${s.hash}.webp`, set: s.set }));
  const files: Change[] = [];
  let record: Record<string, unknown>;
  let before: unknown;
  if (state.existing) {
    before = JSON.parse(state.existing.text);
    record = structuredClone(before) as Record<string, unknown>;
    for (const [k, on] of Object.entries(state.fill)) if (on) record[k] = state.info?.[k as keyof VideoInfo];
    const aps = ((record.appearances as { location: string; screenshots?: unknown[] }[]) ??= []);
    for (const ap of state.appearances) {
      const old = aps.find((a) => a.location === ap.location);
      if (old) old.screenshots = [...(old.screenshots ?? []), ...shots(ap)];
      else aps.push({ location: ap.location, screenshots: shots(ap) });
    }
  } else {
    const vid = parseYoutubeId(state.link)!;
    record = {
      title: state.title.trim(),
      platform: 'youtube',
      url: /\/shorts\//.test(state.link) ? `https://www.youtube.com/shorts/${vid}` : `https://www.youtube.com/watch?v=${vid}`,
      published: state.published,
      artists: state.artists,
      songs: state.songs.map((s) => ({ title: s.title?.trim(), title_ko: s.title_ko?.trim() })).filter((s) => s.title || s.title_ko),
      type: state.type,
      channel: state.channel,
      embeddable: state.embeddable,
      appearances: state.appearances.map((ap) => ({ location: ap.location, screenshots: shots(ap) })),
    };
  }
  files.push({
    path: `content/videos/${state.existing?.file ?? `${id}.json`}`,
    text: serialize(record, cfg.order.videos, before),
    base: state.existing?.sha,
  });
  for (const a of state.newArtists.filter((x) => state.artists.includes(x.id)))
    files.push({ path: `content/artists/${a.id}.json`, text: serialize({ name: a.name.trim() || a.name_ko.trim(), name_ko: a.name.trim() ? a.name_ko.trim() : '', part_of: a.part_of }, cfg.order.artists) });
  for (const e of state.locationEdits)
    if (hasChanges(e)) files.push({ path: `content/locations/${e.id}.json`, text: locationJson(e, cfg.order.locations), base: e.base?.sha });
  for (const hash of uploaded()) files.push({ path: `public/media/full/${hash}.webp`, blob: '' });
  return { files, message: `${state.existing ? 'Update' : 'Add'} Video ${id}${files.length > 1 ? ` +${files.length - 1}` : ''}` };
}

/** A location file changed on GitHub since it was opened: put the edit on top of the new version. */
async function rebaseEdit(path: string): Promise<boolean> {
  const id = path.split('/').pop()!.replace(/\.json$/, '');
  const i = state.locationEdits.findIndex((e) => e.base && e.id === id);
  if (i === -1) return false;
  const file = await store.repo!.file(path);
  if (!file) return false;
  state.locationEdits[i] = rebase(state.locationEdits[i], file.text, file.sha);
  return true;
}

async function save() {
  const repo = store.repo;
  if (!repo || problems().length) return;
  const button = $('qa-save') as HTMLButtonElement;
  const status = $('qa-save-status');
  saving = true;
  button.disabled = true;
  status.dataset.tone = '';
  status.textContent = 'Saving…';
  try {
    const { files, message } = changes();
    for (const f of files) if ('blob' in f) f.blob = await blobOf(f.path.split('/').pop()!.replace('.webp', ''));
    const sha = await repo.commit(files, message);
    const id = state.id!;
    const added = allShots().length;
    for (const f of files) {
      if ('blob' in f) store.snap?.media.push(f.path.split('/').pop()!);
      else if (f.path.startsWith('content/locations/')) remember(f.path.split('/').pop()!.replace(/\.json$/, ''), f.text);
    }
    if (!state.existing) store.snap?.videos.push(`${id}.json`);
    for (const a of state.newArtists) store.artists.push({ id: a.id, name: a.name || a.name_ko, name_ko: a.name_ko });
    await draft.clear();
    state = fresh();
    resetUploads();
    ($('qa-link') as HTMLInputElement).value = '';
    $('qa-link-status').textContent = '';
    $('qa-draft').replaceChildren(); // its images went with the clear
    changed('video', 'artists', 'locations');
    $('qa-result').replaceChildren(
      doneBox(
        h('p', {}, `✓ ${message} — commit ${sha.slice(0, 7)}${added ? `, ${added} screenshot${added === 1 ? '' : 's'}` : ''}. The site updates in a couple of minutes.`),
        h(
          'p',
          {},
          h('a', { href: `${cfg.site}videos/${id}/`, target: '_blank', rel: 'noopener' }, 'Video page ↗'),
          ' · ',
          h('a', { href: `${cfg.admin}#/collections/videos/entries/${encodeURIComponent(id)}`, target: '_blank', rel: 'noopener' }, '✎ Open in the admin'),
          ' · ',
          h('a', { href: `${cfg.admin}todo/` }, 'To-do list'),
        ),
        h('p', { class: 'muted' }, 'If the admin is open in another tab, reload it before editing this video there.'),
      ),
    );
    ($('qa-link') as HTMLInputElement).focus();
  } catch (e) {
    saving = false;
    if (e instanceof MissingBlobError) {
      // GitHub dropped uploaded blobs (they were unused for too long): send them again, then save again.
      await resendAll(() => void save());
      status.textContent = 'GitHub had dropped the uploaded images — sending them again, then saving.';
      return;
    }
    if (e instanceof ConflictError && (await rebaseEdit(e.path).catch(() => false))) {
      changed('locations');
      status.dataset.tone = 'error';
      status.textContent = `${e.path.split('/').pop()} was changed in the admin meanwhile — your changes were put on top of the new version. Check them and save again.`;
      return;
    }
    status.dataset.tone = 'error';
    status.textContent = e instanceof ConflictError ? e.message : `Not saved: ${(e as Error).message}. Your draft is kept — try again.`;
    button.disabled = false;
    return;
  }
  saving = false;
  renderSave();
}

// ------------------------------------------------------------------ start

/** Drafts from before the shared location editor kept new locations as `newLocations`. */
type OldDraft = State & { newLocations?: { id: string; name: string; status: 'identified' | 'unknown'; part_of: string; where: string; tags: string[]; sets: { id: string; name: string }[] }[] };
function upgrade(saved: OldDraft): State {
  const s: State = { ...fresh(), ...saved };
  s.locationEdits ??= [];
  for (const l of saved.newLocations ?? []) {
    const edit = Object.assign(newLocation(l.name), { status: l.status, part_of: l.part_of, tags: l.tags, sets: l.sets.map((x) => ({ ...x, added: true })) });
    const c = parseCoordinates(l.where);
    if (c) edit.coords = `${c.lat}, ${c.lng}`;
    if (/^https?:\/\//.test(l.where.trim())) edit.links.google_maps = [l.where.trim()];
    s.locationEdits.push(edit);
    for (const ap of s.appearances) if (ap.location === l.id) ap.edit = edit.key;
  }
  delete (s as OldDraft).newLocations;
  return s;
}

async function restoreDraft() {
  const saved = await draft.load<OldDraft>();
  if (!saved?.id) return;
  const box = $('qa-draft');
  const n = saved.appearances.reduce((k, a) => k + a.shots.length, 0);
  box.replaceChildren(
    h(
      'div',
      { class: 'qa-banner' },
      h('span', {}, `↻ Unsaved draft: ${saved.title || saved.id}${n ? ` · ${n} screenshot${n === 1 ? '' : 's'}` : ''}`),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: async () => {
            state = upgrade(saved);
            ($('qa-link') as HTMLInputElement).value = state.link;
            const note = state.existing ? 'Draft for a video already in the database.' : 'Draft restored.';
            $('qa-link-status').textContent = note;
            $('qa-result').replaceChildren();
            box.replaceChildren();
            setPasteTarget('shots:0');
            changed('video', 'artists', 'locations');
            for (const s of allShots()) await track(s.hash);
            for (const e of state.locationEdits) for (const hash of e.photos) await track(hash);
            // Locations opened for editing may have been changed in the admin since.
            let moved = 0;
            for (const e of state.locationEdits.filter((x) => x.base)) {
              const path = `content/locations/${e.id}.json`;
              const now = await store.repo!.file(path).catch(() => undefined);
              if (now && now.sha !== e.base!.sha && (await rebaseEdit(path))) moved++;
            }
            if (moved) {
              changed('locations');
              $('qa-link-status').textContent = `${note} ${moved === 1 ? 'A location' : `${moved} locations`} you edit here changed in the admin meanwhile — your changes are now on top of the new version.`;
            }
          },
        },
        'CONTINUE',
      ),
      h('button', { class: 'btn', type: 'button', onclick: async () => (await draft.clear(), box.replaceChildren()) }, 'DISCARD'),
    ),
  );
}

export async function start() {
  if (!(await connect())) return;
  if (!cfg.youtubeKey) $('qa-account').textContent += ' · no YouTube API key: dates must be typed';

  const link = $('qa-link') as HTMLInputElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  link.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => loadLink(link.value.trim()), 400);
  });
  document.addEventListener('paste', (e) => {
    const files = imagesFrom(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });
  $('qa-save').addEventListener('click', () => save());
  window.addEventListener('beforeunload', () => (clearTimeout(persistTimer), void draft.save(state)));
  await restoreDraft();
  // From the admin's "Open in quick add": this video, while a saved draft stays offered in the banner.
  const deep = params.get('link');
  if (deep) {
    link.value = deep;
    await loadLink(deep, true);
  }
  renderSave();
  pump();
}
