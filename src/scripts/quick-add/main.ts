// The quick-add form (src/pages/admin/add.astro). One state object, kept as a draft in IndexedDB; sections are
// redrawn when their structure changes, text fields only update the state (so typing never loses focus).
import { parseYoutubeId, slugify } from '../../lib/ids.ts';
import { cover, full, loadCatalogue, look, thumb, thumbFallback } from './catalogue.ts';
import { draft } from './draft.ts';
import { ConflictError, findToken, github, MissingBlobError, mockRepo, type Change, type Repo, type Snapshot } from './github.ts';
import { guessSong, guessType, hasHangul, matchArtists, parseCoordinates, type Song, type VideoType } from './guess.ts';
import { imagesFrom, toWebp } from './images.ts';
import { serialize, type Order } from './json.ts';
import { VideoNotFound, videoInfo, type VideoInfo } from './youtube.ts';

interface PageConfig {
  repo: string;
  branch: string;
  order: Record<'videos' | 'locations' | 'artists', Order>;
  tags: string[];
  linkIds: Record<string, string>;
  youtubeKey: string;
  admin: string;
  site: string;
  mock?: { snapshot: Snapshot; videos: Record<string, string> };
}

interface Shot {
  hash: string;
  set?: string;
}
interface Appearance {
  location: string;
  shots: Shot[];
}
interface NewArtist {
  id: string;
  name: string;
  name_ko: string;
  part_of: string[];
}
interface NewLocation {
  id: string;
  name: string;
  status: 'identified' | 'unknown';
  part_of: string;
  where: string;
  tags: string[];
  sets: { id: string; name: string }[];
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
  newLocations: NewLocation[];
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
  newLocations: [],
  fill: {},
  guessed: { artists: false, songs: false, type: false },
});

// ------------------------------------------------------------------ small DOM helper

type Child = Node | string | false | null | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Child | Child[])[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else if (k === 'checked') (el as HTMLInputElement).checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== false && kid !== null && kid !== undefined) el.append(kid);
  return el;
}
/** replaceChildren that skips the empty parts (null, false) the sections use for optional pieces. */
const fill = (el: HTMLElement, ...kids: (Child | Child[])[]) =>
  el.replaceChildren(...kids.flat().filter((k): k is Node | string => k !== false && k !== null && k !== undefined));
const $ = (id: string) => document.getElementById(id)!;
const norm = (s = '') => s.normalize('NFKC').toLowerCase();

// ------------------------------------------------------------------ state

const cfg: PageConfig = JSON.parse($('qa-config').textContent!);
const params = new URLSearchParams(location.search);
const branch = params.get('branch') || cfg.branch;
const mockMode = params.has('mock') && cfg.mock ? params.get('mock') || 'on' : undefined;

let repo: Repo | undefined;
let snap: Snapshot | undefined;
let artists: { id: string; name: string; name_ko?: string; part_of?: string[] }[] = [];
let locations: { id: string; name: string; part_of?: string; tags?: string[]; sets?: { id: string; name: string }[] }[] = [];
let state = fresh();
/** Which filming location pasted screenshots go to. */
let active = 0;
let saving = false;
/** The picture catalogue of locations: open or not, its filter text and kind of place. */
const browse = { open: false, query: '', tag: '' };
/** Locations whose "what it looks like" strip was folded away. */
const refClosed = new Set<string>();

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => draft.save(state), 300);
}
/** After a structural change: redraw what depends on it and keep the draft. */
function changed(...parts: ('video' | 'artists' | 'locations')[]) {
  if (parts.includes('video')) renderVideo();
  if (parts.includes('artists')) renderArtists();
  // The locations follow the artists too ("where these artists filmed before").
  if (parts.includes('locations') || parts.includes('artists')) renderLocations();
  renderSave();
  persist();
}

// ------------------------------------------------------------------ uploads

type Upload = { status: 'queued' | 'uploading' | 'done' | 'exists' | 'failed'; progress: number; error?: string; tries: number };
const uploads = new Map<string, Upload>();
const urls = new Map<string, string>();
let running = 0;
const PARALLEL = 2;

function uploadState(hash: string): Upload {
  if (!uploads.has(hash)) uploads.set(hash, { status: 'queued', progress: 0, tries: 0 });
  return uploads.get(hash)!;
}
function paintTile(hash: string) {
  const u = uploadState(hash);
  for (const tile of document.querySelectorAll<HTMLElement>(`[data-hash="${hash}"]`)) {
    tile.dataset.status = u.status;
    const bar = tile.querySelector<HTMLElement>('.qa-bar');
    if (bar) bar.style.width = `${Math.round((u.status === 'done' || u.status === 'exists' ? 1 : u.progress) * 100)}%`;
    const label = tile.querySelector<HTMLElement>('.qa-tile-status');
    if (label)
      label.textContent =
        u.status === 'uploading'
          ? `${Math.round(u.progress * 100)}%`
          : u.status === 'failed'
            ? '✕ failed'
            : u.status === 'queued'
              ? 'waiting'
              : u.status === 'exists'
                ? '✓ already on the site'
                : '✓ uploaded';
  }
  renderSave();
}
function pump() {
  if (!repo) return;
  for (const [hash, u] of uploads) {
    if (running >= PARALLEL) return;
    if (u.status !== 'queued') continue;
    running++;
    u.status = 'uploading';
    u.progress = 0;
    paintTile(hash);
    void (async () => {
      try {
        const stored = await draft.image(hash);
        if (!stored) throw new Error('The image is no longer in this browser — paste it again.');
        const sha = await repo!.upload(stored.blob, (p) => {
          u.progress = p;
          paintTile(hash);
        });
        await draft.putImage(hash, { ...stored, sha });
        u.status = 'done';
      } catch (e) {
        u.tries++;
        u.error = (e as Error).message;
        if (u.tries < 4 && !/no longer in this browser/.test(u.error)) {
          u.status = 'failed';
          setTimeout(() => u.status === 'failed' && ((u.status = 'queued'), pump()), [2, 5, 12][u.tries - 1] * 1000);
        } else u.status = 'failed';
      } finally {
        running--;
        paintTile(hash);
        pump();
        if (retryAfterUpload && allUploaded()) {
          retryAfterUpload = false;
          void save();
        }
      }
    })();
  }
}
function retry(hash: string) {
  const u = uploadState(hash);
  u.status = 'queued';
  u.tries = 0;
  pump();
}
let retryAfterUpload = false;
const allShots = () => state.appearances.flatMap((a) => a.shots);
const allUploaded = () => allShots().every((s) => ['done', 'exists'].includes(uploadState(s.hash).status));

/** Queue a screenshot (already in the draft store): skipped if the site has it, done if uploaded before. */
async function track(hash: string) {
  const u = uploadState(hash);
  if (snap?.media.includes(`${hash}.webp`)) u.status = 'exists';
  else if (u.status !== 'uploading') {
    const stored = await draft.image(hash);
    u.status = stored?.sha ? 'done' : 'queued';
  }
  if (!urls.has(hash)) {
    const stored = await draft.image(hash);
    if (stored) urls.set(hash, URL.createObjectURL(stored.blob));
    // A restored draft draws its tiles before the pictures are read back.
    for (const img of document.querySelectorAll<HTMLImageElement>(`[data-hash="${hash}"] > img`)) img.src = urls.get(hash) ?? '';
  }
  paintTile(hash);
  pump();
}

async function addImages(files: File[], to = active) {
  const ap = state.appearances[to];
  if (!ap) return flash('Add a filming location first, then paste the screenshots into it.');
  for (const file of files) {
    try {
      const { blob, hash } = await toWebp(file);
      if (ap.shots.some((s) => s.hash === hash)) continue;
      await draft.putImage(hash, { blob });
      urls.set(hash, URL.createObjectURL(blob));
      const sets = setsOf(ap.location);
      ap.shots.push({ hash, set: sets.length === 1 ? sets[0].id : undefined });
      changed('locations');
      await track(hash);
    } catch (e) {
      flash((e as Error).message);
    }
  }
}

// ------------------------------------------------------------------ lookups

const artistName = (id: string) => {
  const a = artists.find((x) => x.id === id) ?? state.newArtists.find((x) => x.id === id);
  return a ? [a.name, a.name_ko].filter(Boolean).join(' ') : id;
};
const locationOf = (id: string) => locations.find((l) => l.id === id) ?? state.newLocations.find((l) => l.id === id);
const setsOf = (id: string) => locationOf(id)?.sets?.filter((s) => s.id && s.name) ?? [];
const takenArtist = (id: string) => artists.some((a) => a.id === id);
const takenLocation = (id: string) => locations.some((l) => l.id === id);
/** The artists of the video being added (with their groups), for "filmed here before". */
function videoArtists(): Set<string> {
  const ids: string[] = state.existing ? (JSON.parse(state.existing.text).artists ?? []) : state.artists;
  return new Set(ids.flatMap((id) => [id, ...(artists.find((a) => a.id === id)?.part_of ?? [])]));
}

const thumbImg = (f: string, props: Record<string, unknown> = {}) =>
  h('img', { src: thumb(f), 'data-f': f, alt: '', loading: 'lazy', decoding: 'async', onerror: thumbFallback, ...props });

/** A location as a search option: its picture, area, kinds of place, how many videos and by whom. */
function locationOption(l: (typeof locations)[number]): Option {
  const lk = look(l.id);
  const names = (lk?.artists ?? []).map((id) => artists.find((a) => a.id === id)?.name ?? id);
  return {
    id: l.id,
    label: l.name,
    sub: [
      l.part_of && locationOf(l.part_of)?.name,
      ...(l.tags ?? []),
      lk?.videos ? `${lk.videos} video${lk.videos === 1 ? '' : 's'}` : '',
      names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : ''),
    ]
      .filter(Boolean)
      .join(' · '),
    keys: names.join(' '),
    img: cover(l.id),
  };
}

function flash(text: string) {
  const el = $('qa-save-status');
  el.textContent = text;
  el.dataset.tone = 'error';
}

// ------------------------------------------------------------------ search box

interface Option {
  id: string;
  label: string;
  sub?: string;
  /** Searched but not shown (e.g. every artist who filmed at a location). */
  keys?: string;
  /** A picture file in media/. */
  img?: string;
}
function searchBox(opts: { placeholder: string; options: () => Option[]; pick: (id: string) => void; create?: (text: string) => void; createLabel?: string }) {
  const list = h('ul', { class: 'find-list qa-find-list', role: 'listbox', hidden: true });
  const input = h('input', { type: 'search', placeholder: opts.placeholder, autocomplete: 'off' }) as HTMLInputElement;
  let shown: (Option | { create: string })[] = [];
  let sel = 0;
  const choose = (o: Option | { create: string }) => {
    list.hidden = true;
    input.value = '';
    if ('create' in o) opts.create!(o.create);
    else opts.pick(o.id);
  };
  const draw = () => {
    const q = norm(input.value.trim());
    if (!q) return (list.hidden = true);
    const hits = opts.options().filter((o) => norm(`${o.label} ${o.sub ?? ''} ${o.keys ?? ''} ${o.id}`).includes(q));
    hits.sort((a, b) => Number(!norm(a.label).startsWith(q)) - Number(!norm(b.label).startsWith(q)));
    shown = [...hits.slice(0, 8), ...(opts.create ? [{ create: input.value.trim() }] : [])];
    sel = 0;
    list.replaceChildren(
      ...shown.map((o, i) =>
        h(
          'li',
          { role: 'option', 'aria-selected': i === sel ? 'true' : undefined },
          h(
            'a',
            { href: '#', onmousedown: (e: Event) => (e.preventDefault(), choose(o)) },
            'create' in o
              ? h('span', { class: 'find-name' }, `${opts.createLabel} “${o.create}”`)
              : [
                  'img' in o ? (o.img ? thumbImg(o.img, { class: 'qa-find-img' }) : h('span', { class: 'qa-find-img' })) : null,
                  h('span', { class: 'find-name' }, o.label),
                  o.sub ? h('span', { class: 'find-meta muted' }, o.sub) : null,
                ],
          ),
        ),
      ),
    );
    list.hidden = !shown.length;
  };
  input.addEventListener('input', draw);
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 150));
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === sel)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[sel]) choose(shown[sel]);
    } else if (e.key === 'Escape') list.hidden = true;
  });
  return h('div', { class: 'find qa-search' }, input, list);
}

const field = (label: string, control: HTMLElement, note?: Child) =>
  h('label', { class: 'qa-field' }, h('span', {}, label), control, note instanceof Node || !note ? note : h('small', { class: 'muted' }, note));
const textInput = (value: string, set: (v: string) => void, props: Record<string, unknown> = {}) =>
  h('input', { type: 'text', value, ...props, oninput: (e: Event) => (set((e.target as HTMLInputElement).value), renderSave(), persist()) });
const guessBadge = (on: boolean, text = 'GUESSED — CHECK') => (on ? h('span', { class: 'badge', 'data-kind': 'unsure' }, text) : null);

// ------------------------------------------------------------------ link → video info

async function loadLink(link: string) {
  const status = $('qa-link-status');
  const id = parseYoutubeId(link);
  state = { ...fresh(), link };
  $('qa-result').replaceChildren();
  $('qa-draft').replaceChildren(); // a new link replaces the saved draft
  if (!id) {
    status.textContent = link.trim() ? 'That isn’t a YouTube video link.' : '';
    return changed('video', 'artists', 'locations');
  }
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
      file ? repo!.file(`content/videos/${file}.json`) : Promise.resolve(undefined),
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
      state.artists = matchArtists(`${info.title} ${info.originalTitle}`, info.channel, artists);
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
  active = 0;
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
    artists.filter((a) => !state.artists.includes(a.id)).map((a) => ({ id: a.id, label: a.name, sub: a.name_ko }));
  // A new artist's chip follows its name as it's typed.
  const labels = new Map(state.artists.map((id) => [id, h('span', {}, artistName(id))]));
  fill(box,
    h(
      'ul',
      { class: 'chips qa-chips' },
      state.artists.map((id, i) =>
        h(
          'li',
          {},
          h(
            'span',
            { class: 'chip' },
            labels.get(id),
            state.newArtists.some((a) => a.id === id) ? h('span', { class: 'badge' }, 'NEW') : null,
            h(
              'button',
              {
                type: 'button',
                class: 'qa-x',
                title: 'Remove',
                onclick: () => {
                  // By position: a new artist's id changes while its name is typed.
                  const [gone] = state.artists.splice(i, 1);
                  state.newArtists = state.newArtists.filter((x) => x.id !== gone);
                  state.guessed.artists = false;
                  changed('artists');
                },
              },
              '×',
            ),
          ),
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
      h('ul', { class: 'chips' }, a.part_of.map((g) => h('li', {}, h('span', { class: 'chip' }, artistName(g), h('button', { type: 'button', class: 'qa-x', onclick: () => ((a.part_of = a.part_of.filter((x) => x !== g)), changed('artists')) }, '×'))))),
      searchBox({
        placeholder: 'Group…',
        options: () => artists.filter((x) => !a.part_of.includes(x.id)).map((x) => ({ id: x.id, label: x.name, sub: x.name_ko })),
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
  const options = () => locations.filter((l) => !used.has(l.id)).map(locationOption);
  const startAppearance = (location: string) => {
    state.appearances.push({ location, shots: [] });
    active = state.appearances.length - 1;
    browse.open = false;
    changed('locations');
  };
  // Existing video: its filming locations are offered first.
  const offer = existingAps.filter((a) => !used.has(a.location));
  // Places where this video's artists (or their groups) filmed before.
  const mine = videoArtists();
  const before = locations
    .filter((l) => !used.has(l.id) && !offer.some((a) => a.location === l.id) && look(l.id)?.artists.some((a) => mine.has(a)))
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
          h('div', { class: 'qa-sugs' }, before.map((l) => locationCard(l, startAppearance, true))),
        )
      : null,
    h(
      'div',
      { class: 'qa-row qa-loc-find' },
      searchBox({
        placeholder: state.appearances.length ? 'Another filming location… (name, area, kind, artist)' : 'Filming location… (name, area, kind, artist)',
        options,
        pick: startAppearance,
        createLabel: '+ New location',
        create: (text) => {
          const l: NewLocation = { id: slugify(text), name: text, status: 'identified', part_of: '', where: '', tags: [], sets: [] };
          state.newLocations.push(l);
          startAppearance(l.id);
        },
      }),
      h(
        'button',
        { class: 'btn', type: 'button', 'aria-pressed': String(browse.open), onclick: () => ((browse.open = !browse.open), renderLocations()) },
        browse.open ? 'HIDE PICTURES' : '▦ BROWSE BY PICTURE',
      ),
    ),
    browse.open ? catalogue(used, startAppearance) : null,
  );
  for (const s of allShots()) paintTile(s.hash);
}

/** A location as a picture card: its cover, a few more screenshots, where it is and who filmed there. */
function locationCard(l: (typeof locations)[number], pick: (id: string) => void, small = false) {
  const lk = look(l.id);
  const o = locationOption(l);
  const more = small ? [] : (lk?.shots ?? []).slice(1, 5);
  return h(
    'button',
    { type: 'button', class: small ? 'qa-card qa-card-small' : 'qa-card', title: `${l.name}${o.sub ? `\n${o.sub}` : ''}`, onclick: () => pick(l.id) },
    o.img ? thumbImg(o.img, { class: 'qa-card-cover' }) : h('span', { class: 'qa-card-cover qa-card-empty pixel' }, 'NO PICTURE YET'),
    more.length ? h('span', { class: 'qa-card-more' }, more.map((s) => thumbImg(s.f))) : null,
    h('b', {}, l.name),
    small ? null : h('small', { class: 'muted' }, o.sub),
  );
}

/** Every location as a picture card, filtered by text and kind of place; most-used first. */
function catalogue(used: Set<string>, pick: (id: string) => void) {
  const grid = h('div', { class: 'qa-cat-grid' });
  const draw = () => {
    const q = norm(browse.query.trim());
    const shown = locations
      .filter((l) => !used.has(l.id) && (!browse.tag || l.tags?.includes(browse.tag)))
      .map((l) => ({ l, o: locationOption(l) }))
      .filter(({ l, o }) => !q || norm(`${o.label} ${o.sub} ${o.keys} ${l.id}`).includes(q))
      .sort((a, b) => (look(b.l.id)?.videos ?? 0) - (look(a.l.id)?.videos ?? 0));
    fill(grid, shown.length ? shown.map(({ l }) => locationCard(l, pick)) : h('p', { class: 'qa-note' }, 'No location matches.'));
  };
  draw();
  const tags = h(
    'div',
    { class: 'qa-sets' },
    ['', ...cfg.tags].map((t) =>
      h(
        'button',
        {
          type: 'button',
          class: 'qa-pill',
          'aria-pressed': String(browse.tag === t),
          onclick: (e: Event) => {
            browse.tag = t;
            for (const b of tags.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
            draw();
          },
        },
        t || 'All',
      ),
    ),
  );
  return h(
    'div',
    { class: 'qa-cat' },
    h(
      'div',
      { class: 'qa-row' },
      h('input', {
        type: 'search',
        placeholder: 'Filter: name, area, artist…',
        value: browse.query,
        oninput: (e: Event) => ((browse.query = (e.target as HTMLInputElement).value), draw()),
      }),
      tags,
    ),
    grid,
  );
}

/** Screenshots already on the site for this location — by set when it has several — to compare with. */
function reference(ap: Appearance) {
  const lk = look(ap.location);
  if (!lk?.shots.length) return null;
  const sets = setsOf(ap.location);
  const pic = (f: string, title = '') =>
    h('a', { href: full(f), target: '_blank', rel: 'noopener', title }, thumbImg(f));
  return h(
    'details',
    {
      class: 'qa-ref',
      open: !refClosed.has(ap.location),
      ontoggle: (e: Event) => ((e.target as HTMLDetailsElement).open ? refClosed.delete(ap.location) : refClosed.add(ap.location)),
    },
    h('summary', { class: 'qa-note' }, `What it looks like — ${lk.videos} video${lk.videos === 1 ? '' : 's'} so far${sets.length ? `, ${sets.length} sets` : ''}`),
    sets.length
      ? h(
          'div',
          { class: 'qa-ref-sets' },
          sets.map((s) =>
            h(
              'div',
              { class: 'qa-ref-set' },
              h('span', { class: 'pixel' }, s.name),
              h('div', { class: 'qa-ref-row' }, lk.sets[s.id]?.length ? lk.sets[s.id].map((f) => pic(f, s.name)) : h('small', { class: 'muted' }, 'no screenshot yet')),
            ),
          ),
        )
      : h('div', { class: 'qa-ref-row' }, lk.shots.map((s) => pic(s.f, s.v ?? 'Photo of the place'))),
  );
}

function appearanceBlock(ap: Appearance, i: number, before?: number) {
  const loc = locationOf(ap.location);
  const isNew = state.newLocations.find((l) => l.id === ap.location);
  const heading = h('b', {}, loc?.name || ap.location);
  const picker = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (e: Event) => addImages([...((e.target as HTMLInputElement).files ?? [])], i) });
  const block = h(
    'section',
    {
      class: 'qa-ap',
      'data-active': i === active ? 'true' : undefined,
      onclick: () => {
        if (active !== i) {
          active = i;
          document.querySelectorAll('.qa-ap').forEach((b, j) => b.toggleAttribute('data-active', j === i));
        }
      },
      ondragover: (e: DragEvent) => (e.preventDefault(), block.classList.add('qa-drop')),
      ondragleave: () => block.classList.remove('qa-drop'),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        block.classList.remove('qa-drop');
        addImages(imagesFrom(e.dataTransfer), i);
      },
    },
    h(
      'header',
      { class: 'qa-ap-head' },
      heading,
      isNew ? h('span', { class: 'badge' }, 'NEW') : null,
      before !== undefined ? h('span', { class: 'muted' }, `${before} screenshot${before === 1 ? '' : 's'} already`) : null,
      h('span', { class: 'qa-grow' }),
      h('button', { class: 'btn', type: 'button', onclick: () => picker.click() }, '+ PICK FILES'),
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
            if (isNew) state.newLocations = state.newLocations.filter((l) => l.id !== ap.location);
            active = Math.max(0, Math.min(active, state.appearances.length - 1));
            changed('locations');
          },
        },
        '×',
      ),
      picker,
    ),
    isNew ? newLocationForm(isNew, ap, heading) : reference(ap),
    h(
      'div',
      { class: 'qa-tiles' },
      ap.shots.map((s, j) => tile(ap, s, j)),
      h('div', { class: 'qa-paste' }, 'Ctrl+V pastes into the highlighted location · drop images here'),
    ),
  );
  return block;
}

function tile(ap: Appearance, s: Shot, j: number) {
  const sets = setsOf(ap.location);
  const samples = look(ap.location)?.sets ?? {};
  return h(
    'figure',
    { class: 'qa-tile', 'data-hash': s.hash },
    h('img', { src: urls.get(s.hash) ?? '', alt: '' }),
    h('div', { class: 'qa-progress' }, h('div', { class: 'qa-bar' })),
    h(
      'figcaption',
      {},
      h('span', { class: 'qa-tile-status pixel' }),
      h('button', { type: 'button', class: 'qa-x qa-retry', title: 'Try again', onclick: () => retry(s.hash) }, '↻'),
      h('button', { type: 'button', class: 'qa-x', title: 'Remove', onclick: () => (ap.shots.splice(j, 1), changed('locations')) }, '×'),
    ),
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

function newLocationForm(l: NewLocation, ap: Appearance, heading: HTMLElement) {
  const idNote = h('small', { class: 'muted' });
  const coordNote = h('small', { class: 'muted' });
  const showId = () => {
    const clash = takenLocation(l.id) || state.newLocations.some((x) => x !== l && x.id === l.id);
    idNote.textContent = clash ? `✕ The id “${l.id}” is taken — pick that location instead, or change the name.` : `Page: …/locations/${l.id || '?'}/`;
    idNote.dataset.tone = clash || !l.id ? 'error' : '';
  };
  const showCoords = () => {
    const c = parseCoordinates(l.where);
    coordNote.textContent = !l.where.trim() ? 'Optional.' : c ? `✓ ${c.lat}, ${c.lng}` : '✕ No coordinates found in that — paste "lat, lng" or a full Google Maps link.';
    coordNote.dataset.tone = l.where.trim() && !c ? 'error' : '';
  };
  showId();
  showCoords();
  const setRows = h('div', { class: 'qa-sets-edit' });
  const drawSets = () =>
    setRows.replaceChildren(
      ...l.sets.map((s, i) =>
        h(
          'div',
          { class: 'qa-row' },
          textInput(s.name, (v) => {
            const old = s.id;
            s.name = v;
            s.id = slugify(v);
            for (const shot of ap.shots) if (shot.set === old) shot.set = s.id || undefined;
          }, { placeholder: 'Set name (e.g. Diner)', onchange: () => changed('locations') }),
          h('button', { class: 'btn', type: 'button', onclick: () => (l.sets.splice(i, 1), changed('locations')) }, '×'),
        ),
      ),
      h('button', { class: 'btn', type: 'button', onclick: () => (l.sets.push({ id: '', name: '' }), drawSets()) }, '+ SET'),
    );
  drawSets();
  return h(
    'fieldset',
    { class: 'qa-new' },
    h('legend', {}, 'New location — the rest (address, links, photos) can be added in the admin later'),
    h(
      'div',
      { class: 'qa-row' },
      field(
        'Name',
        textInput(l.name, (v) => {
          const old = l.id;
          l.name = v;
          l.id = slugify(v);
          ap.location = l.id;
          if (old !== l.id) showId();
          heading.textContent = v || '(new location)';
        }),
        idNote,
      ),
      field(
        'Status',
        h(
          'select',
          { onchange: (e: Event) => ((l.status = (e.target as HTMLSelectElement).value as NewLocation['status']), persist()) },
          h('option', { value: 'identified', selected: l.status === 'identified' }, 'Identified'),
          h('option', { value: 'unknown', selected: l.status === 'unknown' }, 'Not identified yet'),
        ),
      ),
    ),
    field('Coordinates or Google Maps link', textInput(l.where, (v) => ((l.where = v), showCoords()), { placeholder: '37.5157, 126.9015 or https://www.google.com/maps/place/…' }), coordNote),
    h(
      'div',
      { class: 'qa-field' },
      h('span', {}, 'Part of (studio or area)'),
      l.part_of
        ? h('ul', { class: 'chips' }, h('li', {}, h('span', { class: 'chip' }, locationOf(l.part_of)?.name ?? l.part_of, h('button', { type: 'button', class: 'qa-x', onclick: () => ((l.part_of = ''), changed('locations')) }, '×'))))
        : searchBox({
            placeholder: 'Studio or area…',
            options: () => locations.map(locationOption),
            pick: (id) => ((l.part_of = id), changed('locations')),
          }),
    ),
    h(
      'div',
      { class: 'qa-field' },
      h('span', {}, 'Kinds of place'),
      h(
        'div',
        { class: 'qa-sets' },
        cfg.tags.map((t) =>
          h(
            'button',
            {
              type: 'button',
              class: 'qa-pill',
              'aria-pressed': String(l.tags.includes(t)),
              onclick: (e: Event) => {
                l.tags = l.tags.includes(t) ? l.tags.filter((x) => x !== t) : [...l.tags, t];
                (e.target as HTMLElement).setAttribute('aria-pressed', String(l.tags.includes(t)));
                persist();
              },
            },
            t,
          ),
        ),
      ),
    ),
    h('div', { class: 'qa-field' }, h('span', {}, 'Sets / spots (only for places with several)'), setRows),
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
  for (const l of state.newLocations) {
    if (!l.id) p.push('A new location needs a name.');
    else if (takenLocation(l.id) || state.newLocations.filter((x) => x.id === l.id).length > 1) p.push(`The location id “${l.id}” is taken.`);
    if (l.where.trim() && !parseCoordinates(l.where)) p.push(`Coordinates of ${l.name} not understood.`);
    const ids = l.sets.map((s) => s.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) p.push(`${l.name} has two sets with the same name.`);
  }
  if (state.existing && !allShots().length && !Object.values(state.fill).some(Boolean)) p.push('Nothing to add yet: paste screenshots.');
  const pending = allShots().filter((s) => !['done', 'exists'].includes(uploadState(s.hash).status));
  if (pending.some((s) => uploadState(s.hash).status === 'failed' && uploadState(s.hash).tries >= 4))
    p.push('Some screenshots failed to upload — press ↻ on them.');
  else if (pending.length) p.push(`Uploading screenshots (${allShots().length - pending.length}/${allShots().length})…`);
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
  for (const l of state.newLocations) {
    const c = parseCoordinates(l.where);
    const link = /^https?:\/\//.test(l.where.trim()) ? l.where.trim() : '';
    files.push({
      path: `content/locations/${l.id}.json`,
      text: serialize(
        {
          name: l.name.trim(),
          status: l.status,
          part_of: l.part_of,
          coordinates: c,
          coordinates_source: c ? (link ? 'google maps link' : 'pasted coordinates') : '',
          links: { google_maps: link ? [link] : [] },
          tags: l.tags,
          sets: l.sets.filter((s) => s.id),
        },
        cfg.order.locations,
      ),
    });
  }
  const images = [...new Set(allShots().map((s) => s.hash))].filter((h) => uploadState(h).status === 'done');
  for (const hash of images) files.push({ path: `public/media/full/${hash}.webp`, blob: '' });
  return { files, message: `${state.existing ? 'Update' : 'Add'} Video ${id}${files.length > 1 ? ` +${files.length - 1}` : ''}` };
}

async function save() {
  if (!repo || problems().length) return;
  const button = $('qa-save') as HTMLButtonElement;
  const status = $('qa-save-status');
  saving = true;
  button.disabled = true;
  status.dataset.tone = '';
  status.textContent = 'Saving…';
  try {
    const { files, message } = changes();
    for (const f of files) if ('blob' in f) f.blob = (await draft.image(f.path.split('/').pop()!.replace('.webp', '')))!.sha!;
    const sha = await repo.commit(files, message);
    const id = state.id!;
    const added = allShots().length;
    for (const f of files) if ('blob' in f) snap?.media.push(f.path.split('/').pop()!);
    if (!state.existing) snap?.videos.push(`${id}.json`);
    for (const a of state.newArtists) artists.push({ id: a.id, name: a.name || a.name_ko, name_ko: a.name_ko });
    for (const l of state.newLocations) locations.push({ ...l });
    await draft.clear();
    state = fresh();
    uploads.clear();
    ($('qa-link') as HTMLInputElement).value = '';
    $('qa-link-status').textContent = '';
    changed('video', 'artists', 'locations');
    $('qa-result').replaceChildren(
      h(
        'section',
        { class: 'win qa-done' },
        h('div', { class: 'win-title' }, h('span', { class: 'win-heading' }, 'Saved')),
        h(
          'div',
          { class: 'win-body' },
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
      ),
    );
    ($('qa-link') as HTMLInputElement).focus();
  } catch (e) {
    if (e instanceof MissingBlobError) {
      // GitHub dropped uploaded blobs (they were unused for too long): send them again, then save again.
      for (const s of allShots()) {
        const stored = await draft.image(s.hash);
        if (stored) await draft.putImage(s.hash, { blob: stored.blob });
        if (uploadState(s.hash).status === 'done') Object.assign(uploadState(s.hash), { status: 'queued', tries: 0 });
      }
      retryAfterUpload = true;
      saving = false;
      for (const s of allShots()) paintTile(s.hash);
      pump();
      status.textContent = 'GitHub had dropped the uploaded screenshots — sending them again, then saving.';
      return;
    }
    status.dataset.tone = 'error';
    status.textContent = e instanceof ConflictError ? e.message : `Not saved: ${(e as Error).message}. Your draft is kept — try again.`;
    saving = false;
    button.disabled = false;
    return;
  }
  saving = false;
  renderSave();
}

// ------------------------------------------------------------------ start

function parseAll() {
  const json = (f: { name: string; text: string }) => {
    try {
      return { id: f.name.replace(/\.json$/, ''), ...JSON.parse(f.text) };
    } catch {
      return undefined;
    }
  };
  artists = snap!.artists.map(json).filter(Boolean);
  locations = snap!.locations.map(json).filter(Boolean);
}

function signInForm(message: string) {
  const input = h('input', { type: 'password', placeholder: 'github_pat_…', autocomplete: 'off' }) as HTMLInputElement;
  $('qa-account').replaceChildren(
    h('span', {}, message, ' Sign in on ', h('a', { href: cfg.admin }, 'the admin page'), ' (same token), then reload — or paste a token here: '),
    input,
    h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: () => {
          try {
            localStorage.setItem('quick-add.token', input.value.trim());
          } catch {}
          location.reload();
        },
      },
      'USE TOKEN',
    ),
  );
}

async function restoreDraft() {
  const saved = await draft.load<State>();
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
            state = { ...fresh(), ...saved };
            ($('qa-link') as HTMLInputElement).value = state.link;
            $('qa-link-status').textContent = state.existing ? 'Draft for a video already in the database.' : 'Draft restored.';
            box.replaceChildren();
            changed('video', 'artists', 'locations');
            for (const s of allShots()) await track(s.hash);
          },
        },
        'CONTINUE',
      ),
      h('button', { class: 'btn', type: 'button', onclick: async () => (await draft.clear(), box.replaceChildren()) }, 'DISCARD'),
    ),
  );
}

export async function start() {
  const account = $('qa-account');
  if (mockMode) {
    (window as unknown as { mockVideos: Record<string, string> }).mockVideos = cfg.mock!.videos;
    repo = mockRepo(cfg.mock!.snapshot, mockMode);
  } else {
    const token = findToken();
    if (!token) return signInForm('Not signed in.');
    repo = github(token, cfg.repo, branch);
  }
  try {
    const [user, s] = await Promise.all([repo.user(), repo.snapshot(), loadCatalogue(cfg.admin, cfg.site)]);
    snap = s;
    parseAll();
    account.textContent = `Signed in as ${user} · ${cfg.repo} (${branch})${mockMode ? ' · MOCK: nothing is sent to GitHub' : ''}${cfg.youtubeKey ? '' : ' · no YouTube API key: dates must be typed'}`;
  } catch (e) {
    return signInForm(`${(e as Error).message}.`);
  }

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
    addImages(files);
  });
  $('qa-save').addEventListener('click', () => save());
  window.addEventListener('beforeunload', () => clearTimeout(persistTimer) || void draft.save(state));
  await restoreDraft();
  renderSave();
}
