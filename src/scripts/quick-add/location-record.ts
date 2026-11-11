// A location being created or edited on a quick-add page, and how it becomes the JSON file. Pure (no DOM),
// tested with `npm test`. An existing location only gets the fields the user touched (`dirty`) written over the
// file it was read from, so the same edit can be replayed on a newer version (a save in the admin meanwhile).
import { slugify } from '../../lib/ids.ts';
import { parseCoordinates } from './guess.ts';
import { serialize, type Order } from './json.ts';

export const LINK_KINDS = ['google_maps', 'naver_map', 'website', 'instagram'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
export type Field = 'name' | 'status' | 'part_of' | 'group_only' | 'address' | 'coords' | 'tags' | 'notes' | `links.${LinkKind}`;

export interface LocationSet {
  id: string;
  name: string;
  /** Added on this page (existing sets are read-only here: their ids are used by screenshots). */
  added?: boolean;
}
export interface LocationEdit {
  /** Stable while the name (and so a new location's id) is typed: paste targets and DOM hooks use it. */
  key: string;
  /** New location: slug of the name, follows it. Existing: fixed. */
  id: string;
  /** The file as read (existing locations); its sha guards the save. */
  base?: { text: string; sha: string };
  name: string;
  status: 'identified' | 'unknown';
  part_of: string;
  group_only: boolean;
  address: string;
  /** What's in the "lat, lng" box. */
  coords: string;
  links: Record<LinkKind, string[]>;
  tags: string[];
  sets: LocationSet[];
  /** Hashes of photos added here (public/media/full/<hash>.webp). */
  photos: string[];
  /** The file's to-dos; done = removed on save. */
  todos: { text: string; done: boolean }[];
  newTodo: string;
  notes: string;
  dirty: Field[];
}

/** A location as the lookups see it. */
export interface Loc {
  id: string;
  name: string;
  status?: string;
  part_of?: string;
  group_only?: boolean;
  tags?: string[];
  sets?: { id: string; name: string }[];
  photos?: string[];
}

export const TODO_UNKNOWN = 'Location not identified yet';
export const TODO_COORDS = 'No coordinates — add a Google Maps link or lat/lng';

let counter = 0;
const newKey = () => `l${Date.now().toString(36)}${(counter++).toString(36)}`;
const emptyLinks = (): Record<LinkKind, string[]> => ({ google_maps: [], naver_map: [], website: [], instagram: [] });

export function newLocation(name: string): LocationEdit {
  return {
    key: newKey(),
    id: slugify(name),
    name,
    status: 'identified',
    part_of: '',
    group_only: false,
    address: '',
    coords: '',
    links: emptyLinks(),
    tags: [],
    sets: [],
    photos: [],
    todos: [],
    newTodo: '',
    notes: '',
    dirty: [],
  };
}

interface File {
  name?: string;
  status?: 'identified' | 'unknown';
  part_of?: string;
  group_only?: boolean;
  address?: string;
  coordinates?: { lat: number; lng: number };
  links?: Partial<Record<LinkKind, string[]>>;
  tags?: string[];
  sets?: { id: string; name: string }[];
  photos?: string[];
  notes?: string;
  review?: string[];
}

/** An existing location opened for editing. */
export function editLocation(id: string, text: string, sha: string): LocationEdit {
  const f = JSON.parse(text) as File;
  return {
    key: newKey(),
    id,
    base: { text, sha },
    name: f.name ?? '',
    status: f.status ?? 'identified',
    part_of: f.part_of ?? '',
    group_only: !!f.group_only,
    address: f.address ?? '',
    coords: f.coordinates ? `${f.coordinates.lat}, ${f.coordinates.lng}` : '',
    links: Object.fromEntries(LINK_KINDS.map((k) => [k, [...(f.links?.[k] ?? [])]])) as Record<LinkKind, string[]>,
    tags: [...(f.tags ?? [])],
    sets: (f.sets ?? []).map((s) => ({ ...s })),
    photos: [],
    todos: (f.review ?? []).map((text) => ({ text, done: false })),
    newTodo: '',
    notes: f.notes ?? '',
    dirty: [],
  };
}

/** The same edit on top of a newer version of the file: untouched fields take the new values. */
export function rebase(edit: LocationEdit, text: string, sha: string): LocationEdit {
  const fresh = editLocation(edit.id, text, sha);
  const out: LocationEdit = { ...fresh, key: edit.key, photos: edit.photos, newTodo: edit.newTodo, dirty: edit.dirty };
  const keep = <K extends keyof LocationEdit>(k: K) => ((out as LocationEdit)[k] = edit[k]);
  for (const f of edit.dirty) {
    if (f.startsWith('links.')) out.links[f.slice(6) as LinkKind] = edit.links[f.slice(6) as LinkKind];
    else keep(f as Exclude<Field, `links.${LinkKind}`>);
  }
  out.sets = [...fresh.sets, ...edit.sets.filter((s) => s.added && !fresh.sets.some((x) => x.id === s.id))];
  out.todos = fresh.todos.map((t) => ({ ...t, done: !!edit.todos.find((x) => x.text === t.text)?.done }));
  return out;
}

export const markDirty = (edit: LocationEdit, f: Field) => edit.dirty.includes(f) || edit.dirty.push(f);

/** Tick (or untick) the to-dos that a change answers: identified → "not identified", coordinates → "no coordinates". */
export function autoTick(edit: LocationEdit) {
  for (const t of edit.todos) {
    if (t.text === TODO_UNKNOWN && edit.dirty.includes('status')) t.done = edit.status === 'identified';
    if (t.text === TODO_COORDS && edit.dirty.includes('coords')) t.done = !!parseCoordinates(edit.coords);
  }
}

/** Coordinates from a full Google Maps link, when the box is still empty (short links carry none). */
export function coordsFromLink(edit: LocationEdit, link: string) {
  const c = parseCoordinates(link);
  if (!c || edit.coords.trim()) return false;
  edit.coords = `${c.lat}, ${c.lng}`;
  markDirty(edit, 'coords');
  return true;
}
export const isShortMapsLink = (link: string) => /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//.test(link.trim());

export const photoPath = (hash: string) => `/media/full/${hash}.webp`;
const cleanLinks = (links: string[]) => links.map((l) => l.trim()).filter(Boolean);
const realSets = (sets: LocationSet[]) => sets.filter((s) => s.id && s.name.trim()).map((s) => ({ id: s.id, name: s.name.trim() }));
const coordSource = (edit: LocationEdit) => (cleanLinks(edit.links.google_maps).length ? 'google maps link' : 'pasted coordinates');

/** The location as the lookups see it while it's edited. */
export const asLoc = (edit: LocationEdit): Loc => ({
  id: edit.id,
  name: edit.name,
  status: edit.status,
  part_of: edit.part_of || undefined,
  group_only: edit.group_only || undefined,
  tags: edit.tags,
  sets: realSets(edit.sets),
});

/** Did anything change compared with the file (or is it new)? */
export const hasChanges = (edit: LocationEdit) =>
  !edit.base || edit.dirty.length > 0 || edit.photos.length > 0 || edit.sets.some((s) => s.added && s.id) || edit.todos.some((t) => t.done) || !!edit.newTodo.trim();

/** The file text. */
export function locationJson(edit: LocationEdit, order: Order): string {
  const c = parseCoordinates(edit.coords);
  if (!edit.base) {
    return serialize(
      {
        review: edit.newTodo.trim() ? [edit.newTodo.trim()] : [],
        name: edit.name.trim(),
        status: edit.status,
        part_of: edit.part_of,
        group_only: edit.group_only || undefined,
        address: edit.address.trim(),
        coordinates: c,
        coordinates_source: c ? coordSource(edit) : '',
        links: Object.fromEntries(LINK_KINDS.map((k) => [k, cleanLinks(edit.links[k])])),
        photos: edit.photos.map(photoPath),
        tags: edit.tags,
        sets: realSets(edit.sets),
        notes: edit.notes.trim(),
      },
      order,
    );
  }
  const before = JSON.parse(edit.base.text) as Record<string, unknown> & File;
  const rec = structuredClone(before) as Record<string, unknown> & File;
  for (const f of edit.dirty) {
    if (f === 'name') rec.name = edit.name.trim();
    else if (f === 'status') rec.status = edit.status;
    else if (f === 'part_of') rec.part_of = edit.part_of || undefined;
    else if (f === 'group_only') rec.group_only = edit.group_only || undefined;
    else if (f === 'address') rec.address = edit.address.trim() || undefined;
    else if (f === 'notes') rec.notes = edit.notes.trim() || undefined;
    else if (f === 'tags') rec.tags = [...edit.tags];
    else if (f === 'coords') {
      rec.coordinates = c;
      rec.coordinates_source = c ? coordSource(edit) : undefined;
    } else {
      const k = f.slice(6) as LinkKind;
      rec.links = { ...rec.links, [k]: cleanLinks(edit.links[k]) };
    }
  }
  const added = realSets(edit.sets.filter((s) => s.added)).filter((s) => !(rec.sets ?? []).some((x) => x.id === s.id));
  if (added.length) rec.sets = [...(rec.sets ?? []), ...added];
  const photos = edit.photos.map(photoPath).filter((p) => !(rec.photos ?? []).includes(p));
  if (photos.length) rec.photos = [...(rec.photos ?? []), ...photos];
  const done = new Set(edit.todos.filter((t) => t.done).map((t) => t.text));
  if (done.size || edit.newTodo.trim()) {
    rec.review = (rec.review ?? []).filter((t) => !done.has(t));
    if (edit.newTodo.trim() && !rec.review.includes(edit.newTodo.trim())) rec.review.push(edit.newTodo.trim());
  }
  return serialize(rec, order, before);
}

/** What stops this location from being saved, in words (empty = fine). `taken`: the id is used already. */
export function locationProblems(edit: LocationEdit, taken: boolean): string[] {
  const p: string[] = [];
  const name = edit.name.trim() || edit.id;
  if (!edit.name.trim()) p.push(edit.base ? `${edit.id} needs a name.` : 'A new location needs a name.');
  else if (!edit.base && !edit.id) p.push(`“${edit.name}” gives no page address — use some Latin letters, digits or Hangul.`);
  else if (!edit.base && taken) p.push(`The location id “${edit.id}” is taken — pick that location instead, or change the name.`);
  if (edit.coords.trim() && !parseCoordinates(edit.coords)) p.push(`Coordinates of ${name} not understood.`);
  const ids = realSets(edit.sets).map((s) => s.id);
  if (new Set(ids).size !== ids.length) p.push(`${name} has two sets with the same name.`);
  return p;
}
