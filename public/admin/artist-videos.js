// Custom admin field "artist-videos": on an artist's form, lists the videos tagged with this artist (with their
// songs, locations and to-dos) and its members / units, each opening its editor in a new tab. Read-only, stores
// nothing. The data is admin/usage.json, written by the site build, so it reflects the last deploy.
//
//   - name: videos_info
//     widget: artist-videos
//     required: false
//
// Also: anywhere in the admin, hovering an artist's name (chips, dropdowns, lists) shows its group(s) or members.
/* global CMS, createClass, h */
(function () {
  const base = `${window.location.origin}${window.location.pathname}`;
  let usage; // Promise of admin/usage.json, fetched once per admin session (↻ fetches it again)
  const fetchUsage = () =>
    (usage = fetch(new URL('usage.json', base), { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null));

  // ---- hover tooltips: Sveltia draws artist names as plain text ("{{name}} {{name_ko}}"), so match the text.
  const norm = (text) => text.replace(/^✎\s*/, '').replace(/\s+/g, ' ').trim();
  const tips = new Map(); // "Kim Lip 김립" / "Kim Lip" -> "Part of LOONA"
  const tip = (text) => {
    const el = text.parentElement;
    const value = el && el.childElementCount === 0 && tips.get(norm(el.textContent));
    if (value && el.title !== value) el.title = value;
  };
  const scan = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return tip(node);
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) tip(walker.currentNode);
  };
  (usage || fetchUsage()).then((data) => {
    if (!data) return;
    const names = (list) => list.map((a) => a.name);
    for (const a of Object.values(data.artists)) {
      const lines = [];
      if (a.groups.length) lines.push(`Part of ${names(a.groups).join(', ')}`);
      if (a.members.length) {
        const shown = names(a.members).slice(0, 8);
        lines.push(`Members & units: ${shown.join(', ')}${a.members.length > shown.length ? ', …' : ''}`);
      }
      if (!lines.length) continue;
      tips.set(norm(a.name), lines.join('\n'));
      if (a.name_ko) tips.set(norm(`${a.name} ${a.name_ko}`), lines.join('\n'));
    }
    scan(document.body);
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'characterData') tip(m.target);
        else m.addedNodes.forEach(scan);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });

  const read = (obj, key) => (obj && typeof obj.get === 'function' ? obj.get(key) : obj && obj[key]);
  const editor = (collection, id) => `${base}#/collections/${collection}/entries/${encodeURIComponent(id)}`;
  const TYPE = { mv: 'MV', performance: 'Performance', live: 'Live', cover: 'Cover', clip: 'Clip', other: 'Video' };

  const link = (collection, id, text) =>
    h('a', { key: id, href: editor(collection, id), target: '_blank', rel: 'noopener', title: `Open ${id} in a new tab` }, `✎ ${text}`);
  const muted = (text, key) => h('span', { key, style: { opacity: 0.7 } }, text);
  const note = (text, key) => h('p', { key, style: { margin: '6px 0', opacity: 0.7 } }, text);

  const ArtistVideos = createClass({
    getInitialState() {
      return { data: undefined };
    },
    componentDidMount() {
      this.load(false);
    },
    componentWillUnmount() {
      this.unmounted = true;
    },
    load(force) {
      if (force || !usage) fetchUsage();
      this.setState({ data: undefined });
      usage.then((data) => !this.unmounted && this.setState({ data }));
    },
    render() {
      const slug = read(this.props.entry, 'slug');
      const { data } = this.state;
      const reload = h('button', { type: 'button', key: '↻', onClick: () => this.load(true), style: { font: 'inherit', cursor: 'pointer' } }, '↻ Reload');
      const report = h('a', { key: 'report', href: new URL('unused/', base).href, target: '_blank', rel: 'noopener' }, 'All unused artists →');

      if (!slug) return note('Save the artist first.');
      if (data === undefined) return note('Loading…');
      if (data === null) return h('div', null, [note('Couldn’t read the site data (admin/usage.json).', 'n'), reload]);
      const info = data.artists[slug];
      if (!info) return h('div', null, [note('Not in the last site update yet — it shows up a minute or two after the next deploy.', 'n'), reload]);

      const children = [];
      if (info.videos.length) {
        children.push(
          h(
            'ul',
            { key: 'videos', style: { margin: '0 0 8px', paddingLeft: '18px' } },
            info.videos.map((v) =>
              h('li', { key: v.id, style: { margin: '4px 0' } }, [
                link('videos', v.id, v.label),
                muted(` · ${TYPE[v.type] || v.type}`, 't'),
                v.locations.length ? muted(' · ', 's') : null,
                ...v.locations.map((l, i) => h('span', { key: l.id }, [i > 0 && ', ', link('locations', l.id, l.name)])),
                v.todo ? h('b', { key: 'todo' }, ` · ${v.todo} to-do${v.todo > 1 ? 's' : ''}`) : null,
                h('div', { key: 'title', style: { fontSize: '12px', opacity: 0.6 } }, v.title),
              ]),
            ),
          ),
        );
      }
      if (info.members.length) {
        children.push(
          h('p', { key: 'members', style: { margin: '6px 0', display: 'flex', flexWrap: 'wrap', gap: '8px' } }, [
            muted('Members & units:', 'l'),
            ...info.members.map((m) => link('artists', m.id, m.name)),
          ]),
        );
      }
      if (!info.videos.length && !info.members.length) {
        children.push(
          h('p', { key: 'unused', style: { margin: '6px 0' } }, [
            h('b', { key: 'b' }, '⚠ No video uses this artist and it has no members or units.'),
            muted(' If it’s obsolete, delete it with the ⋮ menu at the top right.', 'm'),
          ]),
        );
      }
      children.push(
        h('p', { key: 'foot', style: { margin: '6px 0 0', fontSize: '12px', display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' } }, [
          muted(`As of the last site update (${data.built.slice(0, 16).replace('T', ' ')} UTC).`, 'a'),
          reload,
          report,
        ]),
      );
      return h('div', null, children);
    },
  });

  CMS.registerFieldType('artist-videos', ArtistVideos);
})();
