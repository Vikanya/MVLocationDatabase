// Screenshots and photos upload on their own as Git blobs while the form is filled in (max 2 at a time,
// automatic retry with backoff, ↻ by hand after that). The page says which images it holds (`images()`); an
// image used twice (a screenshot that is also a photo) is uploaded once.
import { h } from './dom.ts';
import type { Draft } from './draft.ts';
import { toWebp } from './images.ts';
import { store } from './store.ts';

type Upload = { status: 'queued' | 'uploading' | 'done' | 'exists' | 'failed'; progress: number; error?: string; tries: number };
const uploads = new Map<string, Upload>();
/** Object URLs of the images in this browser, for the tiles. */
export const urls = new Map<string, string>();
let running = 0;
const PARALLEL = 2;

let draft: Draft;
let images: () => string[] = () => [];
let after = () => {};
let thenSave: (() => void) | undefined;

/** `images`: every image hash the form holds now; `changed`: refresh the save bar. */
export function setupUploads(o: { draft: Draft; images: () => string[]; changed: () => void }) {
  draft = o.draft;
  images = () => [...new Set(o.images())];
  after = o.changed;
}

export function uploadState(hash: string): Upload {
  if (!uploads.has(hash)) uploads.set(hash, { status: 'queued', progress: 0, tries: 0 });
  return uploads.get(hash)!;
}
const ready = (hash: string) => ['done', 'exists'].includes(uploadState(hash).status);
export const allUploaded = () => images().every(ready);
/** Hashes uploaded during this visit (the ones the commit must add; 'exists' ones are on the site already). */
export const uploaded = () => images().filter((hash) => uploadState(hash).status === 'done');

/** Why Save must wait, in words (undefined = all uploaded). */
export function uploadProblem(): string | undefined {
  const all = images();
  const pending = all.filter((hash) => !ready(hash));
  if (pending.some((hash) => uploadState(hash).status === 'failed' && uploadState(hash).tries >= 4))
    return 'Some images failed to upload — press ↻ on them.';
  if (pending.length) return `Uploading images (${all.length - pending.length}/${all.length})…`;
}

export function paintTile(hash: string) {
  const u = uploadState(hash);
  for (const tile of document.querySelectorAll<HTMLElement>(`[data-hash="${hash}"]`)) {
    tile.dataset.status = u.status;
    const bar = tile.querySelector<HTMLElement>('.qa-bar');
    if (bar) bar.style.width = `${Math.round((ready(hash) ? 1 : u.progress) * 100)}%`;
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
  after();
}
export const paintAll = () => images().forEach(paintTile);

export function pump() {
  const repo = store.repo;
  if (!repo) return;
  const wanted = new Set(images());
  for (const [hash, u] of uploads) {
    if (running >= PARALLEL) return;
    if (u.status !== 'queued' || !wanted.has(hash)) continue;
    running++;
    u.status = 'uploading';
    u.progress = 0;
    paintTile(hash);
    void (async () => {
      try {
        const stored = await draft.image(hash);
        if (!stored) throw new Error('The image is no longer in this browser — paste it again.');
        const sha = await repo.upload(stored.blob, (p) => {
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
        if (thenSave && allUploaded()) {
          const save = thenSave;
          thenSave = undefined;
          save();
        }
      }
    })();
  }
}

export function retry(hash: string) {
  Object.assign(uploadState(hash), { status: 'queued', tries: 0 });
  pump();
}

/** Queue an image that is in the draft store: skipped if the site has it, done if uploaded before. */
export async function track(hash: string) {
  const u = uploadState(hash);
  if (store.snap?.media.includes(`${hash}.webp`)) u.status = 'exists';
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

/** A pasted / dropped file → WebP in the draft store; returns its hash (the caller puts it in the form, then `track`s it). */
export async function encode(file: Blob): Promise<string> {
  const { blob, hash } = await toWebp(file);
  if (!(await draft.image(hash))) await draft.putImage(hash, { blob });
  if (!urls.has(hash)) urls.set(hash, URL.createObjectURL(blob));
  return hash;
}

/** GitHub dropped uploaded blobs (unused for too long): send them all again, then call `save`. */
export async function resendAll(save: () => void) {
  for (const hash of images()) {
    const stored = await draft.image(hash);
    if (stored) await draft.putImage(hash, { blob: stored.blob });
    if (uploadState(hash).status === 'done') Object.assign(uploadState(hash), { status: 'queued', tries: 0 });
  }
  thenSave = save;
  paintAll();
  pump();
}

/** The sha of an uploaded image (for the commit). */
export const blobOf = async (hash: string) => (await draft.image(hash))!.sha!;
export const resetUploads = () => uploads.clear();

/** An image tile: picture, progress bar, status, ↻ and ×; `extra` goes below (set pills). */
export const imageTile = (hash: string, remove: () => void, extra?: Node | null) =>
  h(
    'figure',
    { class: 'qa-tile', 'data-hash': hash },
    h('img', { src: urls.get(hash) ?? '', alt: '' }),
    h('div', { class: 'qa-progress' }, h('div', { class: 'qa-bar' })),
    h(
      'figcaption',
      {},
      h('span', { class: 'qa-tile-status pixel' }),
      h('button', { type: 'button', class: 'qa-x qa-retry', title: 'Try again', onclick: () => retry(hash) }, '↻'),
      h('button', { type: 'button', class: 'qa-x', title: 'Remove', onclick: remove }, '×'),
    ),
    extra,
  );

// ------------------------------------------------------------------ paste target

/** Where Ctrl+V goes: the element with this `data-target` is highlighted. */
let target = '';
export const pasteTarget = () => target;
export function setPasteTarget(key: string) {
  target = key;
  markTarget();
}
/** Re-apply the highlight after a redraw. */
export function markTarget() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-target]')) el.toggleAttribute('data-active', el.dataset.target === target);
}
