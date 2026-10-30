// The unsaved form and its screenshots, kept in the browser (IndexedDB) so a reload, a closed tab or a failed
// save loses nothing. Images stay here until the commit succeeds, also after they were uploaded: GitHub drops
// uploaded-but-unused blobs after a while, and then they are sent again from this copy.

const DB = 'quick-add';
const open = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('draft');
      req.result.createObjectStore('images');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

let db: Promise<IDBDatabase> | undefined;
async function run<T>(store: 'draft' | 'images', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const conn = await (db ??= open());
  return new Promise((resolve, reject) => {
    const req = fn(conn.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface StoredImage {
  blob: Blob;
  /** Git blob sha once uploaded. */
  sha?: string;
}

export const draft = {
  load: <T>() => run<T | undefined>('draft', 'readonly', (s) => s.get('current')).catch(() => undefined),
  save: (value: unknown) => run('draft', 'readwrite', (s) => s.put(structuredClone(value), 'current')).catch(() => undefined),
  image: (hash: string) => run<StoredImage | undefined>('images', 'readonly', (s) => s.get(hash)).catch(() => undefined),
  putImage: (hash: string, image: StoredImage) => run('images', 'readwrite', (s) => s.put(image, hash)).catch(() => undefined),
  async clear() {
    await run('draft', 'readwrite', (s) => s.clear()).catch(() => undefined);
    await run('images', 'readwrite', (s) => s.clear()).catch(() => undefined);
  },
};
