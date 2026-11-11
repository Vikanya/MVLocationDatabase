// Finding a location by its pictures: search options with a thumbnail, picture cards, the "browse by picture"
// catalogue and the "what it looks like" strip of screenshots already on the site.
import { cover, full, look } from './catalogue.ts';
import { fill, h, norm, thumbImg, type Option } from './dom.ts';
import type { Loc } from './location-record.ts';
import { cfg, locationOf, setsOf, spacesOf, store, studiosOf } from './store.ts';

/** A location as a search option: its picture, area, kinds of place, how many videos and by whom. */
export function locationOption(l: Loc): Option {
  const lk = look(l.id);
  const names = (lk?.artists ?? []).map((id) => store.artists.find((a) => a.id === id)?.name ?? id);
  const spaces = spacesOf(l.id).length;
  return {
    id: l.id,
    label: l.name,
    sub: [
      l.part_of && locationOf(l.part_of)?.name,
      ...(l.tags ?? []),
      spaces ? `${spaces} space${spaces === 1 ? '' : 's'} →` : '',
      lk?.videos ? `${lk.videos} video${lk.videos === 1 ? '' : 's'}` : '',
      names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : ''),
    ]
      .filter(Boolean)
      .join(' · '),
    // Every studio above it too, so "columbus" also finds Acres Space – Subway.
    keys: [...studiosOf(l.id).map((x) => locationOf(x)?.name), ...names].join(' '),
    img: cover(l.id),
  };
}

/** A location as a picture card: its cover, a few more screenshots, where it is and who filmed there. */
export function locationCard(l: Loc, pick: (id: string) => void, note?: string, small = false) {
  const lk = look(l.id);
  const o = locationOption(l);
  const more = small ? [] : (lk?.shots ?? []).slice(1, 5);
  return h(
    'button',
    { type: 'button', class: small ? 'qa-card qa-card-small' : 'qa-card', title: `${l.name}${o.sub ? `\n${o.sub}` : ''}`, onclick: () => pick(l.id) },
    o.img ? thumbImg(o.img, { class: 'qa-card-cover' }) : h('span', { class: 'qa-card-cover qa-card-empty pixel' }, 'NO PICTURE YET'),
    more.length ? h('span', { class: 'qa-card-more' }, more.map((s) => thumbImg(s.f))) : null,
    h('b', {}, l.name),
    note ? h('small', { class: 'pixel' }, note) : null,
    small ? null : h('small', { class: 'muted' }, o.sub),
  );
}

/** The catalogue's state: open or not, its filter text and kind of place, the studio / area shown. */
export interface Browse {
  open: boolean;
  query: string;
  tag: string;
  within: string;
}
export const browseState = (): Browse => ({ open: false, query: '', tag: '', within: '' });

/**
 * Every location as a picture card, filtered by text and kind of place; most-used first. A studio or area card
 * opens its spaces (`open`); inside one, the area itself can be picked too (`pick`) — unless it only groups
 * places and `hubs` is off (a video can't be filmed "at" Acres Space, but its page can be edited).
 */
export function catalogue(o: { browse: Browse; used: Set<string>; open: (id: string) => void; pick: (id: string) => void; back: () => void; hubs?: boolean }) {
  const { browse } = o;
  const grid = h('div', { class: 'qa-cat-grid' });
  const hub = browse.within ? store.locations.find((l) => l.id === browse.within) : undefined;
  const hubPickable = hub && (o.hubs || !hub.group_only);
  const pool = hub ? [...(hubPickable ? [hub] : []), ...spacesOf(hub.id)] : store.locations;
  const draw = () => {
    const q = norm(browse.query.trim());
    const shown = pool
      .filter((l) => !o.used.has(l.id) && (!browse.tag || l.tags?.includes(browse.tag)))
      .map((l) => ({ l, opt: locationOption(l) }))
      .filter(({ l, opt }) => !q || norm(`${opt.label} ${opt.sub} ${opt.keys} ${l.id}`).includes(q))
      .sort((a, b) => Number(b.l === hub) - Number(a.l === hub) || (look(b.l.id)?.videos ?? 0) - (look(a.l.id)?.videos ?? 0));
    fill(
      grid,
      shown.length
        ? shown.map(({ l }) => locationCard(l, l === hub ? o.pick : o.open, l === hub ? `The whole of ${l.name}` : undefined))
        : h('p', { class: 'qa-note' }, 'No location matches.'),
    );
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
    hub
      ? h(
          'p',
          { class: 'qa-note qa-cat-within' },
          h('button', { class: 'btn', type: 'button', onclick: o.back }, '← ALL PLACES'),
          ' ',
          h('b', {}, hub.name),
          hubPickable ? ' — the whole place, or one of its spots:' : ' — pick the space it was filmed in:',
        )
      : null,
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
export function reference(id: string, closed: Set<string>) {
  const lk = look(id);
  if (!lk?.shots.length) return null;
  const sets = setsOf(id);
  const pic = (f: string, title = '') => h('a', { href: full(f), target: '_blank', rel: 'noopener', title }, thumbImg(f));
  return h(
    'details',
    {
      class: 'qa-ref',
      open: !closed.has(id),
      ontoggle: (e: Event) => ((e.target as HTMLDetailsElement).open ? closed.delete(id) : closed.add(id)),
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
