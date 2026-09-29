// Admin location list: shows how many videos were filmed at each location ("27 MV") at the end of its row.
// Sveltia can't compute that, so this reads admin/usage.json (last deploy; a studio counts its spaces' videos)
// and matches each row by the location name at the start of its summary ("{{name}} · {{tags}}").
// Only an attribute is set on Sveltia's empty "status" cell; the text comes from CSS, so its DOM is untouched.
(function () {
  const style = document.createElement('style');
  style.textContent =
    '[data-mv-count]::after { content: attr(data-mv-count); white-space: nowrap; font-size: 12px; opacity: 0.7; padding: 0 8px; }';
  document.head.append(style);

  const onList = () => /^#\/collections\/locations\/?(\?.*)?$/.test(window.location.hash);
  let counts = null;
  const update = () => {
    if (!counts || !onList()) return;
    for (const row of document.querySelectorAll('[role=row]')) {
      const title = row.querySelector('.grid-cell.title');
      const cell = row.querySelector('.grid-cell.status');
      if (!title || !cell) continue;
      const n = counts[title.textContent.split(' · ')[0].trim()];
      const text = n === undefined ? '' : `${n} MV`;
      if (cell.getAttribute('data-mv-count') !== text) cell.setAttribute('data-mv-count', text);
    }
  };
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => ((queued = false), update()), 50); // batches Sveltia's bursts of DOM changes
  };

  window.mvUsage().then((data) => {
    if (!data || !data.locations) return;
    counts = data.locations;
    update();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('hashchange', schedule);
  });
})();
