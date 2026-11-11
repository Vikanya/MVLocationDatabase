// The location quick-add page (src/pages/admin/add-location.astro): find a location (or name a new one), edit it
// with the shared editor, paste photos (uploaded one by one), Save = one commit. Drafts survive reloads.
import { $, doneBox, fill, flash, h, onEdited, searchBox } from './dom.ts';
import { draftStore } from './draft.ts';
import { ConflictError, MissingBlobError, type Change } from './github.ts';
import { imagesFrom } from './images.ts';
import { locationEditor } from './location-form.ts';
import { editLocation, hasChanges, locationJson, locationProblems, newLocation, rebase, type LocationEdit } from './location-record.ts';
import { browseState, catalogue, locationOption, reference } from './picker.ts';
import { branch, cfg, connect, params, remember, spacesOf, store, takenLocation } from './store.ts';
import { blobOf, encode, paintAll, pump, resendAll, resetUploads, setPasteTarget, setupUploads, track, uploaded, uploadProblem } from './uploads.ts';

interface State {
  edit?: LocationEdit;
}

const draft = draftStore('quick-add-location');
let state: State = {};
let saving = false;
const browse = browseState();
const refClosed = new Set<string>();

store.edits = () => (state.edit ? [state.edit] : []);
setupUploads({ draft, images: () => state.edit?.photos ?? [], changed: () => renderSave() });

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => draft.save(state), 300);
}
onEdited(() => (renderSave(), persist()));
function changed() {
  renderFind();
  renderEdit();
  renderSave();
  persist();
}

// ------------------------------------------------------------------ open / create

async function open(id: string) {
  if (!leave()) return;
  const file = await store.repo!.file(`content/locations/${id}.json`).catch((e: Error) => flash(`Couldn’t read ${id}: ${e.message}`));
  if (!file) return;
  state.edit = editLocation(id, file.text, file.sha);
  begin(state.edit);
}
function create(name: string) {
  if (!leave()) return;
  state.edit = newLocation(name);
  begin(state.edit);
}
function begin(edit: LocationEdit) {
  Object.assign(browse, { open: false, within: '' });
  $('qa-result').replaceChildren();
  setPasteTarget(`photos:${edit.key}`);
  changed();
}
/** May the current edit be dropped (nothing changed, or the user agrees)? */
function leave() {
  const e = state.edit;
  if (e && hasChanges(e) && !confirm(`Drop your changes to ${e.name || e.id}?`)) return false;
  state.edit = undefined;
  return true;
}

async function addPhotos(files: File[]) {
  const edit = state.edit;
  if (!edit) return flash('Find a location or type a new name first, then paste its photos.');
  for (const file of files) {
    try {
      const hash = await encode(file);
      if (edit.photos.includes(hash)) continue;
      edit.photos.push(hash);
      changed();
      await track(hash);
    } catch (e) {
      flash((e as Error).message);
    }
  }
}

// ------------------------------------------------------------------ sections

function renderFind() {
  const box = $('ql-find');
  const e = state.edit;
  if (e) {
    return fill(
      box,
      h(
        'p',
        { class: 'qa-note qa-row' },
        h('span', {}, e.base ? 'Editing ' : 'New location ', h('b', {}, e.name || e.id || '…')),
        e.base ? [' · ', h('a', { href: `${cfg.site}locations/${e.id}/`, target: '_blank', rel: 'noopener' }, 'page ↗')] : null,
        e.base ? [' · ', h('a', { href: `${cfg.admin}#/collections/locations/entries/${encodeURIComponent(e.id)}`, target: '_blank', rel: 'noopener' }, '✎ in the admin')] : null,
        h('span', { class: 'qa-grow' }),
        h('button', { class: 'btn', type: 'button', onclick: () => leave() && changed() }, 'OPEN ANOTHER'),
      ),
    );
  }
  // A studio or area card opens its spaces; there the studio itself can be opened too.
  const openCard = (id: string) => {
    if (!spacesOf(id).length) return open(id);
    Object.assign(browse, { open: true, within: id, query: '', tag: '' });
    renderFind();
  };
  fill(
    box,
    h(
      'div',
      { class: 'qa-row qa-loc-find' },
      searchBox({
        placeholder: 'Find a location (name, area, kind, artist) — or type a new one’s name',
        options: () => store.locations.map(locationOption),
        pick: open,
        createLabel: '+ New location',
        create,
      }),
      h(
        'button',
        { class: 'btn', type: 'button', 'aria-pressed': String(browse.open), onclick: () => (Object.assign(browse, { open: !browse.open, within: '' }), renderFind()) },
        browse.open ? 'HIDE PICTURES' : '▦ BROWSE BY PICTURE',
      ),
    ),
    browse.open ? catalogue({ browse, used: new Set(), open: openCard, pick: open, back: () => ((browse.within = ''), renderFind()), hubs: true }) : null,
  );
}

function renderEdit() {
  const box = $('ql-edit');
  const edit = state.edit;
  $('qa-savebar').hidden = !edit;
  if (!edit) return box.replaceChildren();
  fill(
    box,
    locationEditor(edit, {
      groupOnly: true,
      redraw: changed,
      named: () => renderFind(),
      addPhotos,
      removePhoto: (hash) => ((edit.photos = edit.photos.filter((x) => x !== hash)), changed()),
    }),
    edit.base ? reference(edit.id, refClosed) : null,
  );
  paintAll();
}

// ------------------------------------------------------------------ save

function problems(): string[] {
  const e = state.edit;
  if (!e) return ['Find a location, or type a new one’s name.'];
  const p = locationProblems(e, takenLocation(e));
  if (!hasChanges(e)) p.push('Nothing changed yet.');
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

async function save() {
  const repo = store.repo;
  const edit = state.edit;
  if (!repo || !edit || problems().length) return;
  const button = $('qa-save') as HTMLButtonElement;
  const status = $('qa-save-status');
  saving = true;
  button.disabled = true;
  status.dataset.tone = '';
  status.textContent = 'Saving…';
  const path = `content/locations/${edit.id}.json`;
  try {
    const files: Change[] = [{ path, text: locationJson(edit, cfg.order.locations), base: edit.base?.sha }];
    for (const hash of uploaded()) files.push({ path: `public/media/full/${hash}.webp`, blob: await blobOf(hash) });
    const message = `${edit.base ? 'Update' : 'Add'} Location ${edit.id}${files.length > 1 ? ` +${files.length - 1}` : ''}`;
    const sha = await repo.commit(files, message);
    remember(edit.id, (files[0] as { text: string }).text);
    for (const f of files.slice(1)) store.snap?.media.push(f.path.split('/').pop()!);
    const { id } = edit;
    await draft.clear();
    state = {};
    resetUploads();
    $('qa-draft').replaceChildren(); // its images went with the clear
    changed();
    $('qa-result').replaceChildren(
      doneBox(
        h('p', {}, `✓ ${message} — commit ${sha.slice(0, 7)}. The site updates in a couple of minutes.`),
        h(
          'p',
          {},
          h('a', { href: `${cfg.site}locations/${id}/`, target: '_blank', rel: 'noopener' }, 'Location page ↗'),
          ' · ',
          h('a', { href: `${cfg.admin}#/collections/locations/entries/${encodeURIComponent(id)}`, target: '_blank', rel: 'noopener' }, '✎ Open in the admin'),
          ' · ',
          h('a', { href: `${cfg.admin}todo/` }, 'To-do list'),
        ),
        h('p', { class: 'muted' }, 'If the admin is open in another tab, reload it before editing this location there.'),
      ),
    );
  } catch (e) {
    saving = false;
    if (e instanceof MissingBlobError) {
      await resendAll(() => void save());
      status.textContent = 'GitHub had dropped the uploaded photos — sending them again, then saving.';
      return;
    }
    if (e instanceof ConflictError && edit.base) {
      const now = await repo.file(path).catch(() => undefined);
      if (now) {
        state.edit = rebase(edit, now.text, now.sha);
        changed();
        status.dataset.tone = 'error';
        status.textContent = 'This location was changed in the admin meanwhile — your changes were put on top of the new version. Check them and save again.';
        return;
      }
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

async function restoreDraft() {
  const saved = await draft.load<State>();
  const e = saved?.edit;
  if (!e) return;
  const box = $('qa-draft');
  box.replaceChildren(
    h(
      'div',
      { class: 'qa-banner' },
      h('span', {}, `↻ Unsaved draft: ${e.name || e.id}${e.photos.length ? ` · ${e.photos.length} photo${e.photos.length === 1 ? '' : 's'}` : ''}`),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: async () => {
            state = { edit: e };
            box.replaceChildren();
            begin(e);
            for (const hash of e.photos) await track(hash);
            // It may have been changed in the admin since.
            if (e.base) {
              const now = await store.repo!.file(`content/locations/${e.id}.json`).catch(() => undefined);
              if (now && now.sha !== e.base.sha && state.edit === e) {
                state.edit = rebase(e, now.text, now.sha);
                changed();
                $('qa-save-status').textContent = 'This location was changed in the admin since the draft — your changes are now on top of the new version.';
              }
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
  document.addEventListener('paste', (e) => {
    const files = imagesFrom(e.clipboardData);
    if (!files.length || !state.edit) return;
    e.preventDefault();
    addPhotos(files);
  });
  $('qa-save').addEventListener('click', () => save());
  window.addEventListener('beforeunload', () => (clearTimeout(persistTimer), void draft.save(state)));
  await restoreDraft();
  // From the admin's "Open in quick add": this location, while a saved draft stays offered in the banner.
  const deep = params.get('location');
  if (deep) await open(deep);
  // Not changed(): that would save the empty form over the draft before Continue is pressed.
  else (renderFind(), renderSave());
  pump();
}
