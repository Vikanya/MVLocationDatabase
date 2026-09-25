// Custom admin field "entry-links": shows a ✎ link for each entry picked in another relation field of the
// same form, opening that entry's editor in a new tab. It only displays links and never stores a value.
//
//   - name: edit_artists
//     widget: entry-links
//     collection: artists                # collection the links open
//     source: artists                    # field of this entry that holds the picked ids
//   (`source` can reach into lists: `appearances.*.location` = the location of every appearance)
/* global CMS, createClass, h */
(function () {
  const REPO_RAW = 'https://raw.githubusercontent.com/Vikanya/MVLocationDatabase/main/content';
  const names = new Map(); // "artists/ive" -> "IVE", filled lazily from the public repo

  const plain = (value) => (value && typeof value.toJS === 'function' ? value.toJS() : value);

  /** Values at a dotted path, where `*` walks every item of a list. */
  const pick = (value, parts) => {
    if (value == null) return [];
    if (!parts.length) return Array.isArray(value) ? value : [value];
    const [head, ...rest] = parts;
    if (head === '*') return (Array.isArray(value) ? value : []).flatMap((item) => pick(item, rest));
    return pick(value[head], rest);
  };

  // Sveltia passes Immutable-style maps (with .get); fall back to plain objects just in case.
  const read = (obj, key) => (obj && typeof obj.get === 'function' ? obj.get(key) : obj && obj[key]);

  const EntryLinks = createClass({
    getInitialState() {
      return { tick: 0 };
    },
    ids() {
      const data = plain(read(this.props.entry, 'data')) || {};
      const ids = pick(data, String(read(this.props.field, 'source')).split('.'));
      return [...new Set(ids.filter((id) => typeof id === 'string' && id))];
    },
    componentDidMount() {
      this.loadNames();
    },
    componentDidUpdate() {
      this.loadNames();
    },
    loadNames() {
      const collection = read(this.props.field, 'collection');
      for (const id of this.ids()) {
        const key = `${collection}/${id}`;
        if (names.has(key)) continue;
        names.set(key, null); // loading
        fetch(`${REPO_RAW}/${key}.json`, { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            names.set(key, data ? [data.name, data.name_ko].filter(Boolean).join(' ') : '');
            this.setState({ tick: this.state.tick + 1 });
          })
          .catch(() => names.set(key, ''));
      }
    },
    render() {
      const collection = read(this.props.field, 'collection');
      const ids = this.ids();
      const base = `${window.location.origin}${window.location.pathname}`;
      if (!ids.length) {
        return h('p', { style: { margin: 0, opacity: 0.7 } }, 'Nothing picked yet.');
      }
      return h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
        ids.map((id) =>
          h(
            'a',
            {
              key: id,
              href: `${base}#/collections/${collection}/entries/${encodeURIComponent(id)}`,
              target: '_blank',
              rel: 'noopener',
              title: `Open ${id} in a new tab`,
              style: {
                padding: '4px 10px',
                border: '1px solid currentColor',
                borderRadius: '999px',
                textDecoration: 'none',
                fontSize: '13px',
              },
            },
            `✎ ${names.get(`${collection}/${id}`) || id}`,
          ),
        ),
      );
    },
  });

  CMS.registerFieldType('entry-links', EntryLinks);
})();
