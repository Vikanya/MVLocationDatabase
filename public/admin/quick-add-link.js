// Custom admin field "quick-add-link": a link that opens this entry in the quick-add pages (add photos / sets to a
// location, screenshots / locations to a video) in a new tab. It only displays a link and never stores a value.
//
//   - name: quick_add
//     widget: quick-add-link
//     page: location          # location → add-location/?location=<id>; video → add/?link=<the video's Link>
/* global CMS, createClass, h */
(function () {
  const plain = (value) => (value && typeof value.toJS === 'function' ? value.toJS() : value);
  // Sveltia passes Immutable-style maps (with .get); fall back to plain objects just in case.
  const read = (obj, key) => (obj && typeof obj.get === 'function' ? obj.get(key) : obj && obj[key]);
  const note = (text) => h('p', { style: { margin: 0, opacity: 0.7 } }, text);

  const QuickAddLink = createClass({
    render() {
      const page = read(this.props.field, 'page');
      const entry = this.props.entry;
      const slug = read(entry, 'slug');
      const data = plain(read(entry, 'data')) || {};
      if (!slug || read(entry, 'newRecord')) return note('Save this entry first.');
      const base = `${window.location.origin}${window.location.pathname}`;
      let href;
      if (page === 'video') {
        if ((data.platform || 'youtube') !== 'youtube' || !data.url) return note('Quick add handles YouTube videos only.');
        href = new URL(`add/?link=${encodeURIComponent(data.url)}`, base).href;
      } else href = new URL(`add-location/?location=${encodeURIComponent(slug)}`, base).href;
      return h(
        'a',
        {
          href,
          target: '_blank',
          rel: 'noopener',
          style: { display: 'inline-block', padding: '4px 10px', border: '1px solid currentColor', borderRadius: '999px', textDecoration: 'none', fontSize: '13px' },
        },
        '⚡ Open in quick add',
      );
    },
  });

  CMS.registerFieldType('quick-add-link', QuickAddLink);
})();
