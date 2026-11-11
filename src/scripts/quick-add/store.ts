// What both quick-add pages share: the page config, the GitHub (or mock) connection, the live artists and
// locations read from the repo, and lookups over them that also see the locations being edited on the page.
import { loadCatalogue } from './catalogue.ts';
import { $, h } from './dom.ts';
import { findTokens, forgetToken, github, keepToken, mockRepo, signOutEverywhere, TOKEN_COPY, type Repo, type Snapshot } from './github.ts';
import type { Order } from './json.ts';
import { asLoc, type Loc, type LocationEdit } from './location-record.ts';
import { signIn } from './signin.ts';

export interface PageConfig {
  repo: string;
  branch: string;
  order: Record<'videos' | 'locations' | 'artists', Order>;
  tags: string[];
  linkIds: Record<string, string>;
  youtubeKey: string;
  admin: string;
  site: string;
  mock?: { snapshot: Snapshot; videos: Record<string, string> };
}
export interface Artist {
  id: string;
  name: string;
  name_ko?: string;
  part_of?: string[];
}

export const cfg: PageConfig = JSON.parse($('qa-config').textContent!);
export const params = new URLSearchParams(location.search);
export const branch = params.get('branch') || cfg.branch;
export const mockMode = params.has('mock') && cfg.mock ? params.get('mock') || 'on' : undefined;

export const store = {
  repo: undefined as Repo | undefined,
  snap: undefined as Snapshot | undefined,
  artists: [] as Artist[],
  locations: [] as Loc[],
  /** The locations being created / edited on the page (they win over the repo's version in lookups). */
  edits: (): LocationEdit[] => [],
};

// ------------------------------------------------------------------ lookups

export const locationOf = (id: string): Loc | undefined => {
  const edit = store.edits().find((e) => e.id === id);
  return edit ? asLoc(edit) : store.locations.find((l) => l.id === id);
};
export const setsOf = (id: string) => locationOf(id)?.sets?.filter((s) => s.id && s.name) ?? [];
export const artistOf = (id: string) => store.artists.find((a) => a.id === id);
export const takenArtist = (id: string) => store.artists.some((a) => a.id === id);
/** A new location's id clashes with a saved location or another location created on the page. */
export const takenLocation = (edit: LocationEdit) =>
  !!edit.id && (store.locations.some((l) => l.id === edit.id) || store.edits().some((e) => e !== edit && e.id === edit.id));
/** Spaces of a studio / area, at any depth (Columbus Studio → Acres Space → Acres Space – Subway). */
export function spacesOf(id: string) {
  const out: Loc[] = [];
  const walk = (x: string) => {
    for (const l of store.locations) if (l.part_of === x && !out.includes(l)) (out.push(l), walk(l.id));
  };
  walk(id);
  return out;
}
/** The studios / areas a location is part of, nearest first. */
export function studiosOf(id: string) {
  const out: string[] = [];
  for (let x = locationOf(id)?.part_of; x && !out.includes(x); x = locationOf(x)?.part_of) out.push(x);
  return out;
}
/** After a save: the repo now has this location as written. */
export function remember(id: string, text: string) {
  const loc = { id, ...JSON.parse(text) } as Loc;
  const i = store.locations.findIndex((l) => l.id === id);
  if (i === -1) store.locations.push(loc);
  else store.locations[i] = loc;
  if (store.snap && !store.snap.locations.some((f) => f.name === `${id}.json`)) store.snap.locations.push({ name: `${id}.json`, text });
}

// ------------------------------------------------------------------ connect

function parseAll() {
  const json = (f: { name: string; text: string }) => {
    try {
      return { id: f.name.replace(/\.json$/, ''), ...JSON.parse(f.text) };
    } catch {
      return undefined;
    }
  };
  store.artists = store.snap!.artists.map(json).filter(Boolean);
  store.locations = store.snap!.locations.map(json).filter(Boolean);
}

function signInForm(message: string) {
  const input = h('input', { type: 'password', placeholder: 'github_pat_…', autocomplete: 'off' }) as HTMLInputElement;
  $('qa-account').replaceChildren(
    h('span', {}, message, ' Sign in on ', h('a', { href: cfg.admin }, 'the admin page'), ' (same token), then reload — or paste a token here: '),
    input,
    h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: () => {
          try {
            localStorage.setItem(TOKEN_COPY, input.value.trim());
          } catch {}
          location.reload();
        },
      },
      'USE TOKEN',
    ),
  );
}

/**
 * Sign in (or the mock), read the repo and the picture catalogue. False = the sign-in form is shown instead.
 * `note` goes at the end of the "Signed in as …" line.
 */
export async function connect(note = ''): Promise<boolean> {
  const account = $('qa-account');
  const tokens = mockMode ? ['mock'] : findTokens();
  if (mockMode) (window as unknown as { mockVideos: Record<string, string> }).mockVideos = cfg.mock!.videos;
  const load = async (token: string) => {
    const repo = mockMode ? mockRepo(cfg.mock!.snapshot, mockMode) : github(token, cfg.repo, branch);
    const [user, snap] = await Promise.all([repo.user(), repo.snapshot(), loadCatalogue(cfg.admin, cfg.site)]);
    return { repo, user, snap };
  };
  const result = await signIn(
    tokens,
    load,
    {
      trying: (message, attempt) => (account.textContent = `GitHub didn’t answer (${message}) — trying again (${attempt}/2)…`),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      stuck: (message) =>
        new Promise<void>((resolve) => {
          account.replaceChildren(
            h('span', { 'data-tone': 'error' }, `Couldn’t load from GitHub: ${message}. `),
            'You are still signed in — this is GitHub or the connection. ',
            h('button', { class: 'btn', type: 'button', onclick: () => ((account.textContent = 'Trying again…'), resolve()) }, 'RETRY'),
          );
        }),
    },
    forgetToken,
  );
  if (!result.ok) {
    signInForm(result.reason === 'none' ? 'Not signed in.' : 'GitHub refused the saved token (expired or revoked).');
    return false;
  }
  const { repo, user, snap } = result.value;
  store.repo = repo;
  store.snap = snap;
  parseAll();
  // Our own copy: Sveltia forgets its token when one of its loads fails, quick add then still has this one.
  if (!mockMode) keepToken(result.token);
  account.replaceChildren(
    `Signed in as ${user} · ${cfg.repo} (${branch})${mockMode ? ' · MOCK: nothing is sent to GitHub' : ''}${note} · `,
    h(
      'button',
      {
        class: 'qa-link-btn',
        type: 'button',
        title: 'Forget the token in this browser (here and in the admin)',
        onclick: () => {
          if (!confirm('Sign out here and in the admin? You will need your GitHub token to sign in again.')) return;
          signOutEverywhere();
          location.reload();
        },
      },
      'sign out',
    ),
  );
  return true;
}
