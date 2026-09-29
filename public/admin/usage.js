// Shared loader for admin/usage.json (written by the site build: videos per artist / location, as of the last
// deploy). window.mvUsage() returns one Promise per admin session; window.mvUsage(true) fetches it again.
(function () {
  let usage;
  window.mvUsage = (force) =>
    force || !usage
      ? (usage = fetch(new URL('usage.json', `${window.location.origin}${window.location.pathname}`), { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null))
      : usage;
})();
