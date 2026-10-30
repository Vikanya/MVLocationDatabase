// GitHub access for the quick-add page. Screenshots go up one by one as Git blobs while the form is filled in;
// Save then sends only small requests (tree + commit + branch update), so a slow connection never has to push
// every image in one request (which is how the Sveltia admin saves).

export interface RepoFile {
  name: string;
  text: string;
}
export interface Snapshot {
  head: string;
  artists: RepoFile[];
  locations: RepoFile[];
  /** File names in content/videos. */
  videos: string[];
  /** File names in public/media/full. */
  media: string[];
}
export type Change =
  | { path: string; text: string; /** blob sha the edit was based on; undefined = the file must not exist yet */ base?: string }
  | { path: string; blob: string };

export interface Repo {
  /** Who is signed in (GitHub login). */
  user(): Promise<string>;
  snapshot(): Promise<Snapshot>;
  /** A file's text and blob sha, or undefined if it doesn't exist. */
  file(path: string): Promise<{ text: string; sha: string } | undefined>;
  /** Uploads bytes as a blob; resolves with its sha. `progress` gets 0..1. */
  upload(bytes: Blob, progress: (p: number) => void, signal?: AbortSignal): Promise<string>;
  /** One commit with all changes on top of the branch; returns the commit sha. */
  commit(changes: Change[], message: string): Promise<string>;
}

export class ConflictError extends Error {}
/** A blob uploaded earlier is gone from GitHub (unreferenced blobs are cleaned up after a while). */
export class MissingBlobError extends Error {}

const API = 'https://api.github.com';

/** The token the Sveltia admin keeps for this site (same origin), else one pasted on the quick-add page. */
export function findToken(): string | undefined {
  try {
    const user = JSON.parse(localStorage.getItem('sveltia-cms.user') ?? 'null');
    if (user?.token) return user.token;
  } catch {}
  try {
    return localStorage.getItem('quick-add.token') ?? undefined;
  } catch {
    return undefined;
  }
}

function base64(bytes: ArrayBuffer) {
  const u8 = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function github(token: string, repo: string, branch: string): Repo {
  const [owner, name] = repo.split('/');
  const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' };

  async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}/repos/${repo}${path}`, {
      ...init,
      headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(new Error(`GitHub ${res.status}: ${body.message ?? res.statusText}`), { status: res.status });
    }
    return res.json();
  }
  async function graphql<T>(query: string, variables: Record<string, string>): Promise<T> {
    const res = await fetch(`${API}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
    const body = await res.json();
    if (!res.ok || body.errors) throw new Error(`GitHub: ${body.errors?.[0]?.message ?? body.message ?? res.status}`);
    return body.data;
  }

  const tree = (alias: string, path: string, text: boolean) =>
    `${alias}: object(expression: "${branch}:${path}") { ... on Tree { entries { name ${text ? 'object { ... on Blob { text } }' : ''} } } }`;

  async function blobSha(head: string, path: string) {
    const data = await graphql<{ repository: { object: { oid: string } | null } }>(
      `query($o: String!, $n: String!, $e: String!) { repository(owner: $o, name: $n) { object(expression: $e) { oid } } }`,
      { o: owner, n: name, e: `${head}:${path}` },
    );
    return data.repository.object?.oid;
  }

  return {
    async user() {
      const res = await fetch(`${API}/user`, { headers });
      if (!res.ok) throw new Error(res.status === 401 ? 'The saved GitHub token is no longer valid.' : `GitHub ${res.status}`);
      return (await res.json()).login;
    },

    async snapshot() {
      type Entries = { entries: { name: string; object?: { text: string } }[] } | null;
      const data = await graphql<{ repository: Record<string, Entries> & { ref: { target: { oid: string } } } }>(
        `query($o: String!, $n: String!, $r: String!) { repository(owner: $o, name: $n) {
          ref(qualifiedName: $r) { target { oid } }
          ${tree('artists', 'content/artists', true)}
          ${tree('locations', 'content/locations', true)}
          ${tree('videos', 'content/videos', false)}
          ${tree('media', 'public/media/full', false)}
        } }`,
        { o: owner, n: name, r: `refs/heads/${branch}` },
      );
      const r = data.repository;
      if (!r.ref) throw new Error(`The branch "${branch}" doesn't exist.`);
      const files = (e: Entries) => (e?.entries ?? []).map((x) => ({ name: x.name, text: x.object?.text ?? '' }));
      return {
        head: r.ref.target.oid,
        artists: files(r.artists),
        locations: files(r.locations),
        videos: (r.videos?.entries ?? []).map((x) => x.name),
        media: (r.media?.entries ?? []).map((x) => x.name),
      };
    },

    async file(path) {
      const data = await graphql<{ repository: { object: { text: string; oid: string } | null } }>(
        `query($o: String!, $n: String!, $e: String!) { repository(owner: $o, name: $n) { object(expression: $e) { ... on Blob { text oid } } } }`,
        { o: owner, n: name, e: `${branch}:${path}` },
      );
      const o = data.repository.object;
      return o ? { text: o.text, sha: o.oid } : undefined;
    },

    async upload(bytes, progress, signal) {
      const body = JSON.stringify({ content: base64(await bytes.arrayBuffer()), encoding: 'base64' });
      // XMLHttpRequest rather than fetch: it reports upload progress.
      return new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API}/repos/${repo}/git/blobs`);
        xhr.setRequestHeader('Authorization', headers.Authorization);
        xhr.setRequestHeader('Accept', headers.Accept);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.upload.onprogress = (e) => e.lengthComputable && progress(e.loaded / e.total);
        xhr.onload = () => {
          if (xhr.status === 201) resolve(JSON.parse(xhr.responseText).sha);
          else reject(Object.assign(new Error(`GitHub ${xhr.status}`), { status: xhr.status }));
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.ontimeout = () => reject(new Error('Timed out'));
        signal?.addEventListener('abort', () => xhr.abort());
        xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
        xhr.send(body);
      });
    },

    async commit(changes, message) {
      // The branch may move while we work (a save in the admin): retry on top of the new head, as long as
      // none of the files we write were changed there.
      for (let attempt = 0; attempt < 4; attempt++) {
        const ref = await rest<{ object: { sha: string } }>(`/git/ref/heads/${branch}`);
        const head = ref.object.sha;
        for (const c of changes) {
          if (!('text' in c)) continue;
          const now = await blobSha(head, c.path);
          if (now !== c.base)
            throw new ConflictError(
              c.base
                ? `${c.path} was changed meanwhile (probably in the admin). Reload the page to start from the new version — your screenshots are kept.`
                : `${c.path} already exists now. Reload the page to pick it up — your screenshots are kept.`,
            );
        }
        const commit = await rest<{ tree: { sha: string } }>(`/git/commits/${head}`);
        let treeSha: string;
        try {
          treeSha = (
            await rest<{ sha: string }>('/git/trees', {
              method: 'POST',
              body: JSON.stringify({
                base_tree: commit.tree.sha,
                tree: changes.map((c) =>
                  'blob' in c
                    ? { path: c.path, mode: '100644', type: 'blob', sha: c.blob }
                    : { path: c.path, mode: '100644', type: 'blob', content: c.text },
                ),
              }),
            })
          ).sha;
        } catch (e) {
          if ((e as { status?: number }).status === 422) throw new MissingBlobError(String((e as Error).message));
          throw e;
        }
        const created = await rest<{ sha: string }>('/git/commits', {
          method: 'POST',
          body: JSON.stringify({ message, tree: treeSha, parents: [head] }),
        });
        try {
          await rest(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: created.sha, force: false }) });
          return created.sha;
        } catch (e) {
          if ((e as { status?: number }).status !== 422) throw e; // 422 = not a fast-forward: the branch moved
        }
      }
      throw new Error('The branch kept moving while saving. Try again in a minute.');
    },
  };
}

/**
 * Stand-in for GitHub when the page runs under `astro dev` with ?mock: the local content/ (embedded in the
 * page), uploads with fake progress. `?mock=slow` makes uploads slow, `?mock=flaky` makes every 3rd one fail.
 * Commits are kept in window.mockCommits.
 */
export function mockRepo(snapshot: Snapshot, mode: string): Repo {
  const files = new Map<string, string>();
  for (const f of snapshot.artists) files.set(`content/artists/${f.name}`, f.text);
  for (const f of snapshot.locations) files.set(`content/locations/${f.name}`, f.text);
  const videoTexts = (window as unknown as { mockVideos?: Record<string, string> }).mockVideos ?? {};
  for (const [n, t] of Object.entries(videoTexts)) files.set(`content/videos/${n}`, t);
  const sha = (text: string) => `mock-${text.length}-${[...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}`;
  const blobs = new Set<string>();
  let uploads = 0;
  const commits: unknown[] = ((window as unknown as { mockCommits: unknown[] }).mockCommits = []);
  return {
    user: async () => 'mock-user',
    snapshot: async () => snapshot,
    file: async (path) => {
      const text = files.get(path);
      return text === undefined ? undefined : { text, sha: sha(text) };
    },
    upload: (bytes, progress, signal) =>
      new Promise((resolve, reject) => {
        const n = ++uploads;
        const steps = mode.includes('slow') ? 40 : 8;
        let i = 0;
        const timer = setInterval(() => {
          progress(++i / steps);
          if (mode.includes('flaky') && n % 3 === 0 && i === Math.floor(steps / 2)) {
            clearInterval(timer);
            reject(new Error('Network error (mock)'));
          } else if (i === steps) {
            clearInterval(timer);
            const id = `blob-${n}-${bytes.size}`;
            blobs.add(id);
            resolve(id);
          }
        }, 150);
        signal?.addEventListener('abort', () => (clearInterval(timer), reject(new DOMException('Aborted', 'AbortError'))));
      }),
    commit: async (changes, message) => {
      for (const c of changes) {
        if ('blob' in c && !blobs.has(c.blob)) throw new MissingBlobError(`blob ${c.blob} not found (mock)`);
        if ('text' in c && (files.has(c.path) ? sha(files.get(c.path)!) : undefined) !== c.base)
          throw new ConflictError(`${c.path} changed meanwhile (mock)`);
      }
      for (const c of changes) if ('text' in c) files.set(c.path, c.text);
      commits.push({ message, changes });
      console.log('[mock] commit', message, changes);
      return `mock-commit-${commits.length}`;
    },
  };
}
