  // ---------------------------------------------------------------- cache (IndexedDB, youtube.com origin)
  const DB_NAME = 'ytz-cache', STORE = 'transcripts', MT_STORE = 'mt';
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'vid' }).createIndex('t', 't');
        if (!db.objectStoreNames.contains(MT_STORE)) db.createObjectStore(MT_STORE, { keyPath: 'zh' }).createIndex('t', 't');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function tx(mode, fn, store = STORE) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode), st = t.objectStore(store);
      let out; try { out = fn(st); } catch (e) { reject(e); }
      t.oncomplete = () => { db.close(); resolve(out?.result ?? out); };
      t.onerror = () => { db.close(); reject(t.error); };
    }));
  }
  const cacheGet = (vid) => tx('readonly', st => st.get(vid)).catch(e => (log('cache get failed', e), null));
  const cacheDel = (vid) => tx('readwrite', st => st.delete(vid)).catch(e => log('cache del failed', e));
  const cacheClear = () => tx('readwrite', st => st.clear()).catch(e => log('cache clear failed', e));
  async function cachePut(entry) {
    try {
      await tx('readwrite', st => st.put(entry));
      const keys = await tx('readonly', st => st.index('t').getAllKeys());   // ascending by t
      const excess = keys.length - CFG.cacheMax;
      if (excess > 0) await tx('readwrite', st => { keys.slice(0, excess).forEach(k => st.delete(k)); });
    } catch (e) { log('cache put failed', e); }
  }

  // translated-line cache: zh text -> en
  async function mtGetMany(texts) {
    const out = new Map();
    try {
      await tx('readonly', st => { for (const z of texts) { const r = st.get(z); r.onsuccess = () => { if (r.result) out.set(z, r.result.en); }; } }, MT_STORE);
    } catch (e) { log('mt cache get failed', e); }
    return out;
  }
  async function mtPutMany(pairs) {
    try {
      const now = Date.now();
      await tx('readwrite', st => { for (const [zh, en] of pairs) st.put({ zh, en, t: now }); }, MT_STORE);
      const n = await tx('readonly', st => st.count(), MT_STORE);
      if (n > CFG.mtCacheMax) {
        const keys = await tx('readonly', st => st.index('t').getAllKeys(null, n - CFG.mtCacheMax), MT_STORE);
        await tx('readwrite', st => { for (const k of keys) st.delete(k); }, MT_STORE);
      }
    } catch (e) { log('mt cache put failed', e); }
  }
  const mtClear = () => tx('readwrite', st => st.clear(), MT_STORE).catch(e => log('mt clear failed', e));

