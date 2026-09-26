// Custom admin field "set-picker": the "Set / spot" of a screenshot, chosen among the sets of the location of the
// filming-location entry it sits in. Sveltia's relation field can't be filtered by "this list item's location",
// so this field finds its own position in the form (appearances.<n>.screenshots…) and reads that location.
//
//   - name: set
//     widget: set-picker
//     required: false
/* global CMS, createClass, h */
(function () {
  const REPO_RAW = 'https://raw.githubusercontent.com/Vikanya/MVLocationDatabase/main/content/locations';
  const locations = new Map(); // location id -> Promise of the location's JSON (null if it can't be read)
  const loaded = new Map(); // location id -> the resolved JSON, for rendering
  const pickers = new Set(); // mounted pickers

  const plain = (value) => (value && typeof value.toJS === 'function' ? value.toJS() : value);
  const read = (obj, key) => (obj && typeof obj.get === 'function' ? obj.get(key) : obj && obj[key]);

  const pill = (selected) => ({
    padding: '4px 10px',
    border: '1px solid currentColor',
    borderRadius: '999px',
    fontSize: '13px',
    font: 'inherit',
    cursor: 'pointer',
    color: 'inherit',
    background: selected ? 'rgba(127, 127, 127, 0.35)' : 'transparent',
    fontWeight: selected ? 'bold' : 'normal',
  });

  const SetPicker = createClass({
    getInitialState() {
      return { appearance: null, tick: 0 };
    },
    componentDidMount() {
      pickers.add(this);
      // The form section around this field carries its key path, e.g. "appearances.1.screenshots.0.set".
      const find = () => {
        const path = this.el && this.el.closest('[data-key-path]')?.dataset.keyPath;
        const match = path && path.match(/^appearances\.(\d+)\./);
        if (match) this.setState({ appearance: Number(match[1]) });
        else if (!this.unmounted) requestAnimationFrame(find);
      };
      find();
    },
    componentWillUnmount() {
      this.unmounted = true;
      pickers.delete(this);
    },
    locationId() {
      const data = plain(read(this.props.entry, 'data')) || {};
      const appearance = (data.appearances || [])[this.state.appearance];
      return appearance && appearance.location;
    },
    load(id, force) {
      if (!force && locations.has(id)) return;
      loaded.delete(id);
      locations.set(
        id,
        fetch(`${REPO_RAW}/${encodeURIComponent(id)}.json`, { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null)
          .then((data) => {
            loaded.set(id, data);
            pickers.forEach((picker) => picker.setState({ tick: picker.state.tick + 1 })); // all pickers on the page
          }),
      );
      if (force) pickers.forEach((picker) => picker.setState({ tick: picker.state.tick + 1 }));
    },
    render() {
      const value = this.props.value || '';
      const set = (v) => this.props.onChange(v);
      const box = (children) => h('div', { ref: (el) => (this.el = el) }, children);
      const note = (text) => h('p', { style: { margin: '6px 0 0', opacity: 0.7 } }, text);

      if (this.state.appearance === null) return box(value || '…');
      const id = this.locationId();
      if (!id) return box([value && `${value} `, note('Pick the location of this filming location first.')]);
      this.load(id);
      const refresh = h(
        'button',
        { type: 'button', key: '↻', style: pill(false), title: 'Reload the sets (after editing the location)', onClick: () => this.load(id, true) },
        '↻',
      );
      if (!loaded.has(id)) return box('Loading the sets…');
      const location = loaded.get(id);
      const list = location ? location.sets || [] : false;
      if (list === false) {
        return box([
          value && h('b', { key: 'v' }, value),
          note('Couldn’t read this location’s sets. A location created just now shows up a few minutes after saving.'),
          refresh,
        ]);
      }
      if (!list.length && !value) return box(note(`${location.name} has no sets.`));

      const known = list.some((s) => s.id === value);
      return box([
        h(
          'div',
          { key: 'pills', role: 'radiogroup', 'aria-label': `Sets of ${location.name}`, style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' } },
          [
            h('span', { key: 'name', style: { opacity: 0.7, marginRight: '4px' } }, `${location.name}:`),
            h('button', { type: 'button', key: '', role: 'radio', 'aria-checked': !value, style: pill(!value), onClick: () => set('') }, 'None'),
            ...list.map((s) =>
              h(
                'button',
                { type: 'button', key: s.id, role: 'radio', 'aria-checked': s.id === value, style: pill(s.id === value), onClick: () => set(s.id) },
                s.name || s.id,
              ),
            ),
            refresh,
          ],
        ),
        value && !known && note(`⚠ "${value}" isn't a set of this location — pick one above (the site build rejects it).`),
      ]);
    },
  });

  CMS.registerFieldType('set-picker', SetPicker);
})();
