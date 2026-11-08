// A small on-device cache that outlives the tab: a blog's post index, kept with the commit it was read at, so opening the editor again
// asks GitHub only "what is the latest commit?" and reads the index from here when it has not changed. Cleared on sign-out (a private
// blog's titles are in it). Every call may fail (private windows, quota): callers treat a miss and an error alike.
const NAME = 'blog-webcli';
const STORE = 'kv';

const open = () => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
  const r = indexedDB.open(NAME, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const kvGet = (key) => run('readonly', (s) => s.get(key));
export const kvSet = (key, value) => run('readwrite', (s) => s.put(value, key));
export const kvClear = () => run('readwrite', (s) => s.clear());
