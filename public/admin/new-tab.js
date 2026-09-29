// Admin entry lists: middle-click or Ctrl/⌘-click a row to open that entry in a new tab (Sveltia's rows aren't
// links). The row is clicked as usual, and the navigation Sveltia then starts is cancelled and opened in a new tab
// instead, so it works for every entry, including ones created since the last deploy.
(function () {
  let capturing = 0; // until when (ms) the next navigation to an entry goes to a new tab
  const isEntry = (url) => /#\/collections\/[^/]+\/entries\//.test(String(url));
  const take = (url) => {
    if (!capturing || Date.now() > capturing || !isEntry(url)) return false;
    capturing = 0;
    window.open(new URL(url, window.location.href).href, '_blank', 'noopener');
    return true;
  };

  if (window.navigation) {
    window.navigation.addEventListener('navigate', (e) => {
      if (e.cancelable && take(e.destination.url)) e.preventDefault();
    });
  } else {
    // Browsers without the Navigation API: Sveltia navigates with history.pushState.
    const push = history.pushState.bind(history);
    history.pushState = (state, title, url) => (take(url) ? undefined : push(state, title, url));
  }

  const rowOf = (e) => {
    const row = e.target instanceof Element && e.target.closest('[role=row]');
    // entry rows only (not group headers), and not their checkboxes / buttons
    return row && row.querySelector('.grid-cell.title') && !e.target.closest('button, input, a') ? row : null;
  };
  const openInNewTab = (e, row) => {
    e.preventDefault();
    e.stopPropagation();
    capturing = Date.now() + 1000;
    row.click();
  };

  // Middle button: stop the auto-scroll cursor on press, open on release.
  document.addEventListener('mousedown', (e) => e.button === 1 && rowOf(e) && e.preventDefault(), true);
  document.addEventListener('auxclick', (e) => {
    const row = e.button === 1 && rowOf(e);
    if (row) openInNewTab(e, row);
  }, true);
  document.addEventListener('click', (e) => {
    const row = (e.ctrlKey || e.metaKey) && e.isTrusted && rowOf(e);
    if (row) openInNewTab(e, row);
  }, true);
})();
