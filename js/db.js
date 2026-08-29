/*
 * db.js — IndexedDB persistence layer.
 *
 * Stores:
 *   books    : { id, title, author, source, createdAt, cover, lang, status,
 *                voice, model, chapterCount, totalChars, lastPlayed }
 *   chapters : { id: `${bookId}:${index}`, bookId, index, title, text, chars,
 *                status, chunkCount, doneChunks, duration, audioSize, error }
 *   chunks   : { id: `${bookId}:${chIdx}:${chunkIdx}`, bookId, chapterId, blob }
 *   audio    : { id: `${bookId}:${chIdx}`, bookId, blob, type, size, duration }
 *   state    : { key, value }   -- settings, playback positions, misc
 */

const DB_NAME = 'lisan';
const DB_VERSION = 1;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) {
        const s = db.createObjectStore('books', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('chapters')) {
        const s = db.createObjectStore('chapters', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId');
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const s = db.createObjectStore('chunks', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId');
        s.createIndex('chapterId', 'chapterId');
      }
      if (!db.objectStoreNames.contains('audio')) {
        const s = db.createObjectStore('audio', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId');
      }
      if (!db.objectStoreNames.contains('state')) {
        db.createObjectStore('state', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database blocked by another tab'));
  });
  return _dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        try {
          result = fn(s, t);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Transaction aborted'));
      })
  );
}

const wrap = (req) => ({ __req: req });

export const DB = {
  // ---- generic key/value state -------------------------------------------
  async get(key, fallback = null) {
    const row = await tx('state', 'readonly', (s) => wrap(s.get(key)));
    return row === undefined || row === null ? fallback : row.value;
  },
  set(key, value) {
    return tx('state', 'readwrite', (s) => s.put({ key, value }));
  },
  del(key) {
    return tx('state', 'readwrite', (s) => s.delete(key));
  },

  /**
   * Add `delta` to a numeric counter atomically. Several conversion workers
   * finish at once, and a read-then-write from JS would silently lose most of
   * the increments; doing both inside one transaction cannot interleave.
   */
  bump(key, delta) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction('state', 'readwrite');
          const s = t.objectStore('state');
          const req = s.get(key);
          let next = delta;
          req.onsuccess = () => {
            next = (Number(req.result?.value) || 0) + delta;
            s.put({ key, value: next });
          };
          t.oncomplete = () => resolve(next);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error || new Error('Transaction aborted'));
        })
    );
  },

  // ---- books --------------------------------------------------------------
  putBook(book) {
    return tx('books', 'readwrite', (s) => s.put(book));
  },
  getBook(id) {
    return tx('books', 'readonly', (s) => wrap(s.get(id)));
  },
  allBooks() {
    return tx('books', 'readonly', (s) => wrap(s.getAll()));
  },

  // ---- chapters -----------------------------------------------------------
  putChapter(ch) {
    return tx('chapters', 'readwrite', (s) => s.put(ch));
  },
  async putChapters(list) {
    return tx('chapters', 'readwrite', (s) => {
      list.forEach((c) => s.put(c));
    });
  },
  getChapter(id) {
    return tx('chapters', 'readonly', (s) => wrap(s.get(id)));
  },
  async chaptersOf(bookId) {
    const rows = await tx('chapters', 'readonly', (s) => wrap(s.index('bookId').getAll(bookId)));
    return (rows || []).sort((a, b) => a.index - b.index);
  },

  // ---- per-chunk cache (makes conversions resumable) ----------------------
  putChunk(row) {
    return tx('chunks', 'readwrite', (s) => s.put(row));
  },
  getChunk(id) {
    return tx('chunks', 'readonly', (s) => wrap(s.get(id)));
  },
  async chunksOf(chapterId) {
    const rows = await tx('chunks', 'readonly', (s) => wrap(s.index('chapterId').getAll(chapterId)));
    return (rows || []).sort((a, b) => a.index - b.index);
  },
  async clearChunksOf(chapterId) {
    const rows = await this.chunksOf(chapterId);
    return tx('chunks', 'readwrite', (s) => {
      rows.forEach((r) => s.delete(r.id));
    });
  },

  // ---- finished chapter audio --------------------------------------------
  putAudio(row) {
    return tx('audio', 'readwrite', (s) => s.put(row));
  },
  getAudio(id) {
    return tx('audio', 'readonly', (s) => wrap(s.get(id)));
  },
  async audioOf(bookId) {
    return (await tx('audio', 'readonly', (s) => wrap(s.index('bookId').getAll(bookId)))) || [];
  },

  // ---- deletion -----------------------------------------------------------
  async deleteBook(bookId) {
    const chapters = await this.chaptersOf(bookId);
    const audios = await this.audioOf(bookId);
    const chunks = await tx('chunks', 'readonly', (s) => wrap(s.index('bookId').getAll(bookId)));
    await tx('chapters', 'readwrite', (s) => chapters.forEach((c) => s.delete(c.id)));
    await tx('audio', 'readwrite', (s) => audios.forEach((a) => s.delete(a.id)));
    await tx('chunks', 'readwrite', (s) => (chunks || []).forEach((c) => s.delete(c.id)));
    await tx('books', 'readwrite', (s) => s.delete(bookId));
    await this.del('pos:' + bookId);
  },

  async deleteAudioOf(bookId) {
    const audios = await this.audioOf(bookId);
    const chunks = await tx('chunks', 'readonly', (s) => wrap(s.index('bookId').getAll(bookId)));
    await tx('audio', 'readwrite', (s) => audios.forEach((a) => s.delete(a.id)));
    await tx('chunks', 'readwrite', (s) => (chunks || []).forEach((c) => s.delete(c.id)));
    const chapters = await this.chaptersOf(bookId);
    chapters.forEach((c) => {
      c.status = 'pending';
      c.doneChunks = 0;
      c.audioSize = 0;
      c.duration = 0;
      delete c.error;
    });
    await this.putChapters(chapters);
  },
};

/** Ask the browser not to evict our audio when storage gets tight. */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (already) return true;
      return await navigator.storage.persist();
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage: usage || 0, quota: quota || 0 };
    }
  } catch (_) {
    /* ignore */
  }
  return { usage: 0, quota: 0 };
}
