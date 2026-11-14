// Site sections: the menu lists them (Base.astro). A section's other list pages are previewed as windows on
// its own page (the section hub), and their heading's kicker links back up (SectionKicker.astro).

export interface Page {
  label: string;
  path: string;
}
export interface Section extends Page {
  subs: Page[];
}

export const SECTIONS: Section[] = [
  {
    label: 'Locations',
    path: '/locations/',
    subs: [
      { label: 'Map', path: '/map/' },
      { label: 'Kinds of place', path: '/tags/' },
      { label: 'Screenshots', path: '/shots/' },
    ],
  },
  { label: 'Artists', path: '/artists/', subs: [] },
  {
    label: 'Videos',
    path: '/videos/',
    subs: [
      { label: 'By year', path: '/years/' },
      { label: 'Recently added', path: '/new/' },
    ],
  },
];

/** The page's path without the site's base ("/locations/", "/years/2021/"). */
export const pagePath = (url: URL) => url.pathname.replace(import.meta.env.BASE_URL.replace(/\/$/, ''), '') || '/';

/** The section a path belongs to, and the sub-page it is (or sits under: a year under By year). */
export function where(path: string) {
  const under = (p: string) => path.startsWith(p);
  const section = SECTIONS.find((s) => under(s.path) || s.subs.some((x) => under(x.path)));
  const sub = section?.subs.find((x) => under(x.path));
  return { section, sub };
}
