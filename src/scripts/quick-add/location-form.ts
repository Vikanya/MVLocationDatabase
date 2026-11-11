// The location editor of both quick-add pages: a new location, or an existing one opened to add photos / sets,
// fill in coordinates, address, links and tick off its to-dos. The JSON side is in location-record.ts.
import { slugify } from '../../lib/ids.ts';
import { chip, field, fill, h, searchBox, textInput, thumbImg, touch } from './dom.ts';
import { imagesFrom } from './images.ts';
import { parseCoordinates } from './guess.ts';
import {
  autoTick,
  coordsFromLink,
  isShortMapsLink,
  LINK_KINDS,
  markDirty,
  type LinkKind,
  type LocationEdit,
} from './location-record.ts';
import { locationOption } from './picker.ts';
import { cfg, locationOf, store, takenLocation } from './store.ts';
import { imageTile, markTarget, setPasteTarget } from './uploads.ts';

export interface EditorOptions {
  /** Video page: the less used fields fold away under "More details". */
  compact?: boolean;
  /** Location page only: "only groups places" (a filming location can't be one). */
  groupOnly?: boolean;
  /** Redraw the page part that holds the editor (a structural change). */
  redraw: () => void;
  /** A new location's id follows its name. */
  idChanged?: (old: string, now: string) => void;
  /** The name as typed (for a heading). */
  named?: (name: string) => void;
  /** A new set's id changed or the set was removed (undefined): screenshots using it follow. */
  setChanged?: (old: string, now: string | undefined) => void;
  addPhotos: (files: File[]) => void;
  removePhoto: (hash: string) => void;
}

const LINK_LABELS: Record<LinkKind, [string, string]> = {
  google_maps: ['Google Maps link', 'https://maps.app.goo.gl/… or https://www.google.com/maps/place/…'],
  naver_map: ['Naver Map link', 'https://naver.me/…'],
  website: ['Website', 'https://…'],
  instagram: ['Instagram', 'https://www.instagram.com/…'],
};

/** Editors whose "More details" fold is open (the form is redrawn often). */
const moreOpen = new Set<string>();

export function locationEditor(edit: LocationEdit, o: EditorOptions) {
  const isNew = !edit.base;

  // ---------------------------------------------------------------- to-dos
  const todoBox = h('div', { class: 'qa-field qa-todos' });
  const drawTodos = () =>
    todoBox.replaceChildren(
      h('span', {}, 'To-do'),
      ...edit.todos.map((t) =>
        h(
          'label',
          { class: 'qa-check', 'data-done': t.done ? 'true' : undefined },
          h('input', {
            type: 'checkbox',
            checked: t.done,
            onchange: (e: Event) => ((t.done = (e.target as HTMLInputElement).checked), drawTodos(), touch()),
          }),
          ` ${t.text}`,
          t.done ? h('small', { class: 'muted' }, ' — removed on save') : null,
        ),
      ),
      textInput(edit.newTodo, (v) => (edit.newTodo = v), { placeholder: isNew ? 'A to-do for later (optional), e.g. Check the address' : 'Add a to-do (optional)' }),
    );
  drawTodos();
  const answered = () => (autoTick(edit), drawTodos());

  // ---------------------------------------------------------------- name, status
  const idNote = h('small', { class: 'muted' });
  const showId = () => {
    const clash = isNew && takenLocation(edit);
    idNote.textContent = clash
      ? `✕ The id “${edit.id}” is taken — pick that location instead, or change the name.`
      : isNew
        ? `Page: …/locations/${edit.id || '?'}/`
        : `Page stays …/locations/${edit.id}/ (changing the address is done in the admin).`;
    idNote.dataset.tone = clash || !edit.id ? 'error' : '';
  };
  showId();
  const name = field(
    'Name',
    textInput(edit.name, (v) => {
      edit.name = v;
      markDirty(edit, 'name');
      if (isNew) {
        const old = edit.id;
        edit.id = slugify(v);
        if (old !== edit.id) o.idChanged?.(old, edit.id);
      }
      showId();
      o.named?.(v);
    }),
    idNote,
  );
  const status = field(
    'Status',
    h(
      'select',
      {
        onchange: (e: Event) => {
          edit.status = (e.target as HTMLSelectElement).value as LocationEdit['status'];
          markDirty(edit, 'status');
          answered();
          touch();
        },
      },
      h('option', { value: 'identified', selected: edit.status === 'identified' }, 'Identified'),
      h('option', { value: 'unknown', selected: edit.status === 'unknown' }, 'Not identified yet'),
    ),
  );

  const partOf = h(
    'div',
    { class: 'qa-field' },
    h('span', {}, 'Part of (studio or area)'),
    edit.part_of
      ? h('ul', { class: 'chips' }, chip(locationOf(edit.part_of)?.name ?? edit.part_of, () => ((edit.part_of = ''), markDirty(edit, 'part_of'), o.redraw())))
      : searchBox({
          placeholder: 'Studio or area…',
          options: () => store.locations.filter((l) => l.id !== edit.id).map(locationOption),
          pick: (id) => ((edit.part_of = id), markDirty(edit, 'part_of'), o.redraw()),
        }),
  );
  const groupOnly = o.groupOnly
    ? h(
        'label',
        { class: 'qa-check' },
        h('input', {
          type: 'checkbox',
          checked: edit.group_only,
          onchange: (e: Event) => ((edit.group_only = (e.target as HTMLInputElement).checked), markDirty(edit, 'group_only'), touch()),
        }),
        ' Only groups places (a studio / rental company page: videos are linked to its spaces, never to it)',
      )
    : null;

  // ---------------------------------------------------------------- coordinates + links
  const coordNote = h('small', { class: 'muted' });
  const showCoords = () => {
    const c = parseCoordinates(edit.coords);
    coordNote.textContent = !edit.coords.trim()
      ? 'From Google Maps: right-click the place, click the numbers to copy them.'
      : c
        ? `✓ ${c.lat}, ${c.lng}`
        : '✕ Not understood — paste "lat, lng" or a full Google Maps link.';
    coordNote.dataset.tone = edit.coords.trim() && !c ? 'error' : '';
  };
  showCoords();
  const coordInput = textInput(
    edit.coords,
    (v) => {
      // A full Maps link pasted here: keep the coordinates, and the link under Google Maps.
      const c = parseCoordinates(v);
      if (c && /^https?:\/\//.test(v.trim())) {
        edit.links.google_maps = [...edit.links.google_maps.filter((l) => l.trim()), v.trim()];
        markDirty(edit, 'links.google_maps');
        v = `${c.lat}, ${c.lng}`;
        (coordInput as HTMLInputElement).value = v;
        drawLinks.google_maps();
      }
      edit.coords = v;
      markDirty(edit, 'coords');
      showCoords();
      answered();
    },
    { placeholder: '37.5157, 126.9015' },
  ) as HTMLInputElement;

  const drawLinks = {} as Record<LinkKind, () => void>;
  const linkBox = (k: LinkKind) => {
    const box = h('div', { class: 'qa-field' });
    const [label, placeholder] = LINK_LABELS[k];
    drawLinks[k] = () => {
      if (!edit.links[k].length) edit.links[k] = [''];
      box.replaceChildren(
        h('span', {}, label),
        ...edit.links[k].map((link, i) => {
          const note = h('small', { class: 'muted' });
          const explain = (v: string) =>
            (note.textContent = k === 'google_maps' && isShortMapsLink(v) && !edit.coords.trim() ? 'Short link: paste the coordinates below as well (they can’t be read from it).' : '');
          explain(link);
          return h(
            'div',
            { class: 'qa-link-row' },
            h(
              'div',
              { class: 'qa-row' },
              textInput(
                link,
                (v) => {
                  edit.links[k][i] = v;
                  markDirty(edit, `links.${k}`);
                  if (k === 'google_maps' && coordsFromLink(edit, v)) {
                    coordInput.value = edit.coords;
                    showCoords();
                    answered();
                  }
                  explain(v);
                },
                { type: 'url', placeholder },
              ),
              edit.links[k].length > 1
                ? h('button', { class: 'btn', type: 'button', title: 'Remove', onclick: () => (edit.links[k].splice(i, 1), markDirty(edit, `links.${k}`), drawLinks[k](), touch()) }, '×')
                : null,
            ),
            note,
          );
        }),
        h('button', { class: 'btn qa-add', type: 'button', onclick: () => (edit.links[k].push(''), drawLinks[k]()) }, '+ ANOTHER'),
      );
    };
    drawLinks[k]();
    return box;
  };
  const [maps, naver, website, instagram] = LINK_KINDS.map(linkBox);

  const address = field('Address', textInput(edit.address, (v) => ((edit.address = v), markDirty(edit, 'address')), { placeholder: 'As Google Maps writes it' }));
  const notes = field(
    'Notes',
    h('textarea', { rows: 2, oninput: (e: Event) => ((edit.notes = (e.target as HTMLTextAreaElement).value), markDirty(edit, 'notes'), touch()) }, edit.notes),
  );

  // ---------------------------------------------------------------- kinds, sets
  const kinds = h(
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
            'aria-pressed': String(edit.tags.includes(t)),
            onclick: (e: Event) => {
              edit.tags = edit.tags.includes(t) ? edit.tags.filter((x) => x !== t) : [...edit.tags, t];
              markDirty(edit, 'tags');
              (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(edit.tags.includes(t)));
              touch();
            },
          },
          t,
        ),
      ),
    ),
  );

  const setRows = h('div', { class: 'qa-sets-edit' });
  const drawSets = () => {
    const old = edit.sets.filter((s) => !s.added);
    fill(
      setRows,
      old.length ? h('ul', { class: 'chips' }, old.map((s) => h('li', {}, h('span', { class: 'chip' }, s.name)))) : null,
      ...edit.sets.map((s, i) =>
        s.added
          ? h(
              'div',
              { class: 'qa-row' },
              textInput(
                s.name,
                (v) => {
                  const before = s.id;
                  s.name = v;
                  s.id = slugify(v);
                  if (before !== s.id) o.setChanged?.(before, s.id || undefined);
                },
                { placeholder: 'Set name (e.g. Diner)', onchange: () => o.redraw() },
              ),
              h(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  title: 'Remove',
                  onclick: () => {
                    edit.sets.splice(i, 1);
                    o.setChanged?.(s.id, undefined);
                    o.redraw();
                  },
                },
                '×',
              ),
            )
          : null,
      ),
      h('button', { class: 'btn qa-add', type: 'button', onclick: () => (edit.sets.push({ id: '', name: '', added: true }), drawSets()) }, '+ SET'),
    );
  };
  drawSets();
  const sets = h(
    'div',
    { class: 'qa-field' },
    h('span', {}, isNew ? 'Sets / spots (only for places with several)' : 'Sets / spots — add new ones here; renaming or deleting is done in the admin'),
    setRows,
  );

  // ---------------------------------------------------------------- photos
  const key = `photos:${edit.key}`;
  const picker = h('input', {
    type: 'file',
    accept: 'image/*',
    multiple: true,
    hidden: true,
    onchange: (e: Event) => o.addPhotos([...((e.target as HTMLInputElement).files ?? [])]),
  });
  const before: string[] = edit.base ? (JSON.parse(edit.base.text).photos ?? []) : [];
  const zone = h(
    'div',
    {
      class: 'qa-photos',
      'data-target': key,
      onclick: (e: Event) => (e.stopPropagation(), setPasteTarget(key)),
      ondragover: (e: DragEvent) => (e.preventDefault(), e.stopPropagation(), zone.classList.add('qa-drop')),
      ondragleave: () => zone.classList.remove('qa-drop'),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('qa-drop');
        setPasteTarget(key);
        o.addPhotos(imagesFrom(e.dataTransfer));
      },
    },
    h(
      'div',
      { class: 'qa-ap-head' },
      h('span', {}, before.length ? `Photos of the place — ${before.length} already` : 'Photos of the place'),
      h('span', { class: 'qa-grow' }),
      h('button', { class: 'btn', type: 'button', onclick: () => picker.click() }, '+ PICK FILES'),
      picker,
    ),
    before.length ? h('div', { class: 'qa-ref-row' }, before.map((p) => thumbImg(p.split('/').pop()!))) : null,
    h(
      'div',
      { class: 'qa-tiles' },
      edit.photos.map((hash) => imageTile(hash, () => o.removePhoto(hash))),
      h('div', { class: 'qa-paste' }, 'Click here, then Ctrl+V pastes photos of the place · or drop them here'),
    ),
  );

  const more = [address, naver, website, instagram, notes, zone];
  const form = h(
    'fieldset',
    { class: 'qa-new qa-loc-edit' },
    h('legend', {}, isNew ? 'New location' : `Edit ${edit.name || edit.id}`),
    edit.todos.length || !isNew ? todoBox : null,
    h('div', { class: 'qa-row' }, name, status),
    partOf,
    groupOnly,
    maps,
    field('Coordinates', coordInput, coordNote),
    kinds,
    sets,
    o.compact
      ? h(
          'details',
          {
            class: 'qa-more',
            open: moreOpen.has(edit.key) || edit.photos.length > 0,
            ontoggle: (e: Event) => ((e.target as HTMLDetailsElement).open ? moreOpen.add(edit.key) : moreOpen.delete(edit.key)),
          },
          h('summary', { class: 'qa-note' }, 'More details — address, links, notes, photos of the place'), ...more)
      : more,
  );
  // The new form may hold the paste target's element: re-apply the highlight.
  setTimeout(markTarget);
  return form;
}
