// Small DOM helpers shared by the quick-add pages (video: add.astro, location: add-location.astro).
import { thumb, thumbFallback } from './catalogue.ts';

export type Child = Node | string | false | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Child | Child[])[]) {
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
export const fill = (el: HTMLElement, ...kids: (Child | Child[])[]) =>
  el.replaceChildren(...kids.flat().filter((k): k is Node | string => k !== false && k !== null && k !== undefined));
export const $ = (id: string) => document.getElementById(id)!;
export const norm = (s = '') => s.normalize('NFKC').toLowerCase();

/** What a page does after any typed edit (refresh the save bar, keep the draft). Set by the page. */
let edited = () => {};
export const onEdited = (fn: () => void) => (edited = fn);
export const touch = () => edited();

export function flash(text: string) {
  const el = $('qa-save-status');
  el.textContent = text;
  el.dataset.tone = 'error';
}

export const field = (label: string, control: HTMLElement, note?: Child) =>
  h('label', { class: 'qa-field' }, h('span', {}, label), control, note instanceof Node || !note ? note : h('small', { class: 'muted' }, note));
export const textInput = (value: string, set: (v: string) => void, props: Record<string, unknown> = {}) =>
  h('input', { type: 'text', value, ...props, oninput: (e: Event) => (set((e.target as HTMLInputElement).value), touch()) });
export const guessBadge = (on: boolean, text = 'GUESSED — CHECK') => (on ? h('span', { class: 'badge', 'data-kind': 'unsure' }, text) : null);

export const thumbImg = (f: string, props: Record<string, unknown> = {}) =>
  h('img', { src: thumb(f), 'data-f': f, alt: '', loading: 'lazy', decoding: 'async', onerror: thumbFallback, ...props });

/** A removable chip. */
export const chip = (label: Child, remove: () => void, ...extra: Child[]) =>
  h('li', {}, h('span', { class: 'chip' }, label, ...extra, h('button', { type: 'button', class: 'qa-x', title: 'Remove', onclick: remove }, '×')));

// ------------------------------------------------------------------ search box

export interface Option {
  id: string;
  label: string;
  sub?: string;
  /** Searched but not shown (e.g. every artist who filmed at a location). */
  keys?: string;
  /** A picture file in media/. */
  img?: string;
}
export function searchBox(opts: {
  placeholder: string;
  options: () => Option[];
  pick: (id: string) => void;
  create?: (text: string) => void;
  createLabel?: string;
}) {
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

/** A "Saved" box under the form. */
export const doneBox = (...body: Child[]) =>
  h(
    'section',
    { class: 'win qa-done' },
    h('div', { class: 'win-title' }, h('span', { class: 'win-heading' }, 'Saved')),
    h('div', { class: 'win-body' }, ...body),
  );
