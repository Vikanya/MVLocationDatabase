// One shared <dialog> that shows a screenshot at full resolution; links still work without JS.
// It browses the visible a[data-lightbox] links of the clicked one's group (closest [data-lightbox-group],
// else the whole page), so filtered-out shots (hidden ancestors) are skipped.

let dialog: HTMLDialogElement | undefined;
let links: HTMLAnchorElement[] = [];
let index = 0;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: (Node | string)[]) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  node.append(...kids);
  return node;
};

function build() {
  const d = document.createElement('dialog');
  d.className = 'lightbox';
  d.innerHTML =
    '<div class="lightbox-bar"><span class="lightbox-caption"></span><span class="lightbox-nav">' +
    '<button class="btn" type="button" data-step="-1" aria-label="Previous screenshot">‹</button>' +
    '<span class="lightbox-count"></span>' +
    '<button class="btn" type="button" data-step="1" aria-label="Next screenshot">›</button>' +
    '</span><form method="dialog"><button class="btn" aria-label="Close">×</button></form></div><img alt="">';
  d.addEventListener('click', (e) => {
    const step = (e.target as Element).closest<HTMLElement>('[data-step]');
    if (step) show(index + Number(step.dataset.step));
    else if (e.target === d) d.close();
  });
  d.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
    else return;
    e.preventDefault();
  });
  let startX: number | undefined;
  d.addEventListener('pointerdown', (e) => (startX = e.clientX));
  d.addEventListener('pointerup', (e) => {
    if (startX === undefined) return;
    const dx = e.clientX - startX;
    startX = undefined;
    if (Math.abs(dx) > 50) show(index + (dx < 0 ? 1 : -1));
  });
  document.body.append(d);
  return d;
}

/** "label @ place · set": each part is a link when it has an href; falls back to data-caption. */
function caption(link: HTMLAnchorElement) {
  const { videoLabel, videoHref, locationLabel, locationHref, setName, caption: plain } = link.dataset;
  const part = (text: string, href?: string) => (href ? el('a', { href }, text) : text);
  const parts: (Node | string)[] = [];
  if (videoLabel) parts.push(part(videoLabel, videoHref));
  if (locationLabel) parts.push(videoLabel ? ' @ ' : '', part(locationLabel, locationHref));
  if (!parts.length) return [plain || 'Screenshot'];
  if (setName) parts.push(` · ${setName}`);
  return parts;
}

function show(i: number) {
  if (!dialog || !links.length) return;
  index = (i + links.length) % links.length;
  const link = links[index];
  dialog.querySelector('.lightbox-caption')!.replaceChildren(...caption(link));
  dialog.querySelector('.lightbox-count')!.textContent = `${index + 1} / ${links.length}`;
  dialog.querySelector<HTMLElement>('.lightbox-nav')!.hidden = links.length < 2;
  const img = dialog.querySelector('img')!;
  img.src = link.href;
  img.alt = link.dataset.caption || 'Screenshot';
  // Preload the neighbours so stepping feels instant.
  for (const n of [index - 1, index + 1]) if (links.length > 1) new Image().src = links[(n + links.length) % links.length].href;
}

document.addEventListener('click', (event) => {
  const link = (event.target as Element).closest<HTMLAnchorElement>('a[data-lightbox]');
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  const group = link.closest('[data-lightbox-group]') ?? document;
  links = [...group.querySelectorAll<HTMLAnchorElement>('a[data-lightbox]')].filter((a) => !a.closest('[hidden]'));
  dialog ??= build();
  show(Math.max(0, links.indexOf(link)));
  if (!dialog.open) dialog.showModal();
});
