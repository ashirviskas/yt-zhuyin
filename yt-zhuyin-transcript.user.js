// ==UserScript==
// @name         YouTube 注音 transcript (zh-TW + zhuyin, pinyin optional, English)
// @namespace    local.yt-zhuyin
// @version      0.6.1
// @description  Side panel: traditional Chinese captions segmented into words with zhuyin from a Taiwan (McBopomofo) dictionary, optional pinyin derived from the zhuyin, English line, click-to-seek.
// @match        https://www.youtube.com/*
// @homepageURL  https://github.com/ashirviskas/yt-zhuyin
// @downloadURL  https://raw.githubusercontent.com/ashirviskas/yt-zhuyin/main/yt-zhuyin-transcript.user.js
// @updateURL    https://raw.githubusercontent.com/ashirviskas/yt-zhuyin/main/yt-zhuyin-transcript.user.js
// @require      https://cdn.jsdelivr.net/gh/ashirviskas/yt-zhuyin@main/zhuyin-dict.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * Pipeline
 *  1. Ask the player to load a caption track -> it issues a timedtext request carrying its own
 *     PoT token. A PerformanceObserver catches that URL; we reuse it with different lang/tlang.
 *  2. Fetch: zh track, zh auto-translated to en (1:1 timing), native en track if present.
 *  3. Each zh line -> unigram max-likelihood segmentation over the zhuyin-native dictionary
 *     (ZHUYIN_DICT from @require; built from McBopomofo BPMFMappings + phrase.occ).
 *  4. Render: word groups, one vertical zhuyin column per character, hover shows alternate
 *     readings for polyphonic single characters. Pinyin is derived FROM the zhuyin, only if on.
 */

(() => {
  'use strict';

  const CFG = {
    zhPreference: ['zh-TW', 'zh-Hant', 'zh-HK', 'zh', 'zh-Hans', 'zh-CN'],
    englishDefault: 'native',   // 'native' (human en track, time-overlap aligned) | 'translate' (1:1)
    showPinyin: false,
    showEnglish: true,
    follow: true,
    wordGap: true,              // visible gap between dictionary words
    restoreCaptions: true,      // put player captions back to whatever they were after harvesting
    panelMaxHeight: '60vh',
    zhuyinLayout: 'side',       // 'side' (textbook: vertical column right of the character) | 'top' (horizontal, above)
    hanFontSize: '30px',
    zhuyinFontSize: '14px',     // side layout: ~half the character height is the readable minimum on a 96-dpi screen
    zhuyinTopFontSize: '13px',
    cacheTtlMs: 60 * 60 * 1000, // transcript cache TTL
    cacheMax: 50,               // max cached videos (oldest evicted)
    harvestAttempts: 3,         // caption-load triggers before giving up
    harvestTimeoutMs: 3000,     // per attempt
    waitForPlaybackMs: 15000,   // wait for the player to start before harvesting (captions load lazily)
    asrServer: 'http://127.0.0.1:8765', // local asr_server.py; set null to disable
    asrPollMs: 4000,
    localTranslate: true,       // ask the local server for a per-line English translation when YouTube has none
    translateBatch: 24,         // sentences per /translate request; smaller = English shows up sooner on long videos
    translateUnit: 'sentence',  // 'sentence': group lines into sentences before translating (English shown on the first line) | 'line'
    sentenceMaxChars: 60,       // sentence grouping: force a break after this many characters
    sentenceGapSec: 1.5,        // sentence grouping: a pause longer than this ends a sentence
    mtCacheMax: 20000,          // translated lines kept in IndexedDB (oldest evicted)         // lines per /translate request; smaller = English shows up sooner on long videos
    asrMaxChars: 14,            // re-chunk whisper word timestamps into lines of at most this many characters
    asrMinChars: 4,             // don't cut on a pause before this many characters
    asrGapSec: 0.7,             // a silence longer than this ends a line            // how often to poll the server while it transcribes
    pollMs: 100,                // highlight update interval; one getCurrentTime() call per tick
    debug: true,
  };

  // ---------------------------------------------------------------- core
  // ---- segmentation over zhuyin-native dictionary (unigram max-likelihood) ----
  function segment(text, D, maxLen = 6) {
    const n = text.length, best = new Array(n + 1).fill(-Infinity), back = new Array(n + 1).fill(null);
    const LT = Math.log(D.total || 2e7), UNK = -14;   // unigram log-prob; unknown single char ~ rare word
    best[0] = 0;
    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue;
      const c = D.c[text[i]];
      push(c ? { len: 1, zy: [c[0][0]], score: Math.log((c[1] || 0) + 1) - LT - 1, alts: c[0] }
             : { len: 1, zy: [null], score: UNK, alts: null });
      for (let L = 2; L <= maxLen && i + L <= n; L++) {
        const w = D.w[text.slice(i, i + L)];
        if (w) push({ len: L, zy: w[0].split(' '), score: Math.log((w[1] || 0) + 1) - LT, alts: null });
      }
      function push(cand) {
        const s = best[i] + cand.score, j = i + cand.len;
        if (s > best[j]) { best[j] = s; back[j] = { i, cand }; }
      }
    }
    const out = [];
    for (let j = n; j > 0; j = back[j].i) { const { cand, i } = back[j]; out.unshift({ text: text.slice(i, j), zy: cand.zy, alts: cand.alts }); }
    return out;
  }
  // ---- zhuyin normalisation + zhuyin -> pinyin ----
  const Z_INIT = { 'ㄅ':'b','ㄆ':'p','ㄇ':'m','ㄈ':'f','ㄉ':'d','ㄊ':'t','ㄋ':'n','ㄌ':'l','ㄍ':'g','ㄎ':'k','ㄏ':'h','ㄐ':'j','ㄑ':'q','ㄒ':'x','ㄓ':'zh','ㄔ':'ch','ㄕ':'sh','ㄖ':'r','ㄗ':'z','ㄘ':'c','ㄙ':'s' };
  const Z_FIN = { 'ㄚ':'a','ㄛ':'o','ㄜ':'e','ㄝ':'ê','ㄞ':'ai','ㄟ':'ei','ㄠ':'ao','ㄡ':'ou','ㄢ':'an','ㄣ':'en','ㄤ':'ang','ㄥ':'eng','ㄦ':'er',
    'ㄧ':'i','ㄧㄚ':'ia','ㄧㄛ':'io','ㄧㄝ':'ie','ㄧㄞ':'iai','ㄧㄠ':'iao','ㄧㄡ':'iu','ㄧㄢ':'ian','ㄧㄣ':'in','ㄧㄤ':'iang','ㄧㄥ':'ing',
    'ㄨ':'u','ㄨㄚ':'ua','ㄨㄛ':'uo','ㄨㄞ':'uai','ㄨㄟ':'ui','ㄨㄢ':'uan','ㄨㄣ':'un','ㄨㄤ':'uang','ㄨㄥ':'ong',
    'ㄩ':'ü','ㄩㄝ':'üe','ㄩㄢ':'üan','ㄩㄣ':'ün','ㄩㄥ':'iong' };
  const Z_STANDALONE = { 'ㄧ':'yi','ㄧㄚ':'ya','ㄧㄛ':'yo','ㄧㄝ':'ye','ㄧㄞ':'yai','ㄧㄠ':'yao','ㄧㄡ':'you','ㄧㄢ':'yan','ㄧㄣ':'yin','ㄧㄤ':'yang','ㄧㄥ':'ying',
    'ㄨ':'wu','ㄨㄚ':'wa','ㄨㄛ':'wo','ㄨㄞ':'wai','ㄨㄟ':'wei','ㄨㄢ':'wan','ㄨㄣ':'wen','ㄨㄤ':'wang','ㄨㄥ':'weng',
    'ㄩ':'yu','ㄩㄝ':'yue','ㄩㄢ':'yuan','ㄩㄣ':'yun','ㄩㄥ':'yong' };
  const TONE_MARK = { '':'\u0304', 'ˊ':'\u0301', 'ˇ':'\u030c', 'ˋ':'\u0300', '˙':'' };
  // textbook form: neutral ˙ in front, other tones after
  function normZhuyin(s) { return s.endsWith('˙') ? '˙' + s.slice(0, -1) : s; }
  function zhuyinToPinyin(s) {
    let tone = '';
    if (s.startsWith('˙')) { tone = '˙'; s = s.slice(1); }
    else if (s.endsWith('˙')) { tone = '˙'; s = s.slice(0, -1); }
    else if ('ˊˇˋ'.includes(s.at(-1))) { tone = s.at(-1); s = s.slice(0, -1); }
    let init = Z_INIT[s[0]] ? s[0] : '', fin = s.slice(init.length);
    let py;
    if (!init) py = Z_STANDALONE[fin] ?? Z_FIN[fin];
    else { py = Z_INIT[init] + (fin ? (Z_FIN[fin] ?? '?') : 'i'); if ('jqx'.includes(Z_INIT[init])) py = py.replace('ü', 'u'); }
    if (!py) return '?';
    const m = TONE_MARK[tone]; if (!m) return py;
    const vowels = 'aoeêiuü'; let idx = -1;
    for (const v of ['a', 'o', 'e', 'ê']) { idx = py.indexOf(v); if (idx >= 0) break; }
    if (idx < 0) { for (let k = py.length - 1; k >= 0; k--) if (vowels.includes(py[k])) { idx = k; break; } }
    return (py.slice(0, idx + 1) + m + py.slice(idx + 1)).normalize('NFC');
  }

  // ---------------------------------------------------------------- helpers
  const log = (...a) => CFG.debug && console.log('[yt-zhuyin]', ...a);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function waitFor(fn, { tries = 60, every = 250 } = {}) {
    for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await sleep(every); }
    return null;
  }
  const fmtTime = (sec) => { sec = Math.floor(sec); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : m) + ':' + String(s).padStart(2, '0'); };
  const trackName = (t) => t.name?.simpleText ?? t.name?.runs?.map(r => r.text).join('') ?? t.languageCode;

  function pickZhTrack(tracks) {
    for (const code of CFG.zhPreference) {
      const t = tracks.find(t => t.languageCode === code && t.kind !== 'asr') || tracks.find(t => t.languageCode === code);
      if (t) return t;
    }
    return tracks.find(t => /^zh/i.test(t.languageCode)) ?? null;
  }

  function parseJson3(j) {
    const out = [];
    for (const ev of j.events ?? []) {
      if (!ev.segs || ev.aAppend) continue;
      const text = ev.segs.map(s => s.utf8 ?? '').join('').replace(/\n/g, ' ').trim();
      if (!text) continue;
      const start = ev.tStartMs / 1000;
      out.push({ start, end: start + (ev.dDurationMs ?? 0) / 1000, text });
    }
    return out;
  }

  // Wait until the player is actually playing (state 1); the captions module doesn't request a
  // track for a cued/unstarted player. Returns false if playback never started (autoplay blocked).
  function waitForPlayback(player, ms) {
    return new Promise(resolve => {
      if (player.getPlayerState?.() === 1) return resolve(true);
      let done = false;
      const finish = (ok) => { if (done) return; done = true; player.removeEventListener?.('onStateChange', onState); clearTimeout(tm); resolve(ok); };
      const onState = (st) => { if (st === 1) finish(true); };
      player.addEventListener?.('onStateChange', onState);
      const tm = setTimeout(() => finish(player.getPlayerState?.() === 1), ms);
    });
  }

  // Get a signed timedtext URL (with pot) by making the player fetch a track itself.
  // One attempt: trigger a caption (re)load, watch the Performance API for the resulting request.
  function harvestOnce(player, langCode, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (u) => { if (done) return; done = true; obs.disconnect(); clearTimeout(tm); resolve(u); };
      const isTT = (u) => u.includes('/api/timedtext') && u.includes('pot=');
      const obs = new PerformanceObserver((list) => { const hit = list.getEntries().find(e => isTT(e.name)); if (hit) finish(hit.name); });
      obs.observe({ type: 'resource', buffered: false });
      try {
        player.loadModule?.('captions');
        player.setOption('captions', 'track', { languageCode: langCode });
        player.setOption('captions', 'reload', true);   // documented way to force a caption refetch
      } catch (e) { log('caption trigger threw', e); }
      const tm = setTimeout(() => {
        const late = performance.getEntriesByType('resource').map(e => e.name).filter(isTT);
        finish(late.at(-1) ?? null);
      }, timeoutMs);
    });
  }

  async function harvestTimedtextUrl(player, langCode, altLang) {
    const prev = player.getOption?.('captions', 'track');
    // anything already in the resource buffer from this page load is fine to reuse
    const early = performance.getEntriesByType('resource').map(e => e.name).filter(u => u.includes('/api/timedtext') && u.includes('pot='));
    let url = early.at(-1) ?? null;
    if (!url) {
      const playing = await waitForPlayback(player, CFG.waitForPlaybackMs);
      log('playback started:', playing, 'state', player.getPlayerState?.());
      for (let i = 0; i < CFG.harvestAttempts && !url; i++) {
        // alternate tracks so each attempt is a different request the player can't short-circuit
        const lang = (i % 2 === 0 || !altLang) ? langCode : altLang;
        url = await harvestOnce(player, lang, CFG.harvestTimeoutMs);
        log('harvest attempt', i + 1, lang, url ? 'ok' : 'nothing');
      }
    }
    if (CFG.restoreCaptions) setTimeout(() => {
      try { if (prev && prev.languageCode) player.setOption('captions', 'track', prev); else player.setOption('captions', 'track', {}); } catch {}
    }, 500);
    return url;
  }

  async function fetchTrack(signedUrl, lang, tlang) {
    const u = new URL(signedUrl);
    u.searchParams.set('lang', lang); u.searchParams.set('fmt', 'json3');
    if (tlang) u.searchParams.set('tlang', tlang); else u.searchParams.delete('tlang');
    const r = await fetch(u, { credentials: 'same-origin' });
    const txt = await r.text();
    if (!r.ok) throw new Error(`timedtext ${lang}${tlang ? '->' + tlang : ''} HTTP ${r.status}`);
    if (!txt) throw new Error(`timedtext ${lang} empty body`);
    return parseJson3(JSON.parse(txt));
  }

  function alignByOverlap(zh, en) {
    let j = 0;
    return zh.map(z => {
      while (j < en.length && en[j].end <= z.start) j++;
      const parts = [];
      for (let k = j; k < en.length && en[k].start < z.end; k++) parts.push(en[k].text);
      return parts.join(' ');
    });
  }

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

  // ---------------------------------------------------------------- render
  const CSS = `
  #ytz-panel{margin:0 0 12px;border:1px solid var(--yt-spec-10-percent-layer,#333);border-radius:12px;background:var(--yt-spec-base-background,#0f0f0f);color:var(--yt-spec-text-primary,#f1f1f1);font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",Roboto,sans-serif;overflow:hidden}
  #ytz-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--yt-spec-10-percent-layer,#333);font-size:13px}
  #ytz-head .ytz-title{font-weight:500;margin-right:auto}
  #ytz-head label{display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none}
  #ytz-head button{background:transparent;color:inherit;border:1px solid var(--yt-spec-10-percent-layer,#333);border-radius:4px;padding:2px 8px;cursor:pointer;font:inherit}
  #ytz-head button:hover{background:var(--yt-spec-badge-chip-background,#272727)}
  #ytz-head input[type=range]{width:90px;accent-color:#ff0033}
  #ytz-head select{background:transparent;color:inherit;border:1px solid var(--yt-spec-10-percent-layer,#333);border-radius:4px}
  #ytz-status{padding:10px 12px;font-size:13px;color:var(--yt-spec-text-secondary,#aaa)}
  #ytz-body{position:relative;max-height:${CFG.panelMaxHeight};overflow-y:auto}
  .ytz-row{display:grid;grid-template-columns:52px 1fr;gap:8px;padding:8px 12px;cursor:pointer;border-left:3px solid transparent}
  .ytz-row:hover{background:var(--yt-spec-badge-chip-background,#272727)}
  .ytz-row.ytz-active{border-left-color:#ff0033;background:var(--yt-spec-badge-chip-background,#272727)}
  .ytz-ts{font-size:12px;color:var(--yt-spec-text-secondary,#aaa);padding-top:6px;font-variant-numeric:tabular-nums}
  .ytz-zh{line-height:1.15}
  .ytz-word{display:inline-flex;align-items:center;margin:0 ${CFG.wordGap ? 7 : 2}px 4px 0;vertical-align:middle;border-bottom:1px dotted transparent}
  #ytz-panel.ytz-wordgap .ytz-word{border-bottom-color:var(--yt-spec-10-percent-layer,#444)}
  .ytz-cc{display:inline-flex;align-items:center;margin-right:3px}
  .ytz-han{font-size:${CFG.hanFontSize};line-height:1}
  .ytz-zy{writing-mode:vertical-lr;text-orientation:upright;font-size:${CFG.zhuyinFontSize};line-height:1;margin-left:2px;color:var(--yt-spec-text-secondary,#aaa);white-space:nowrap;font-family:"Noto Sans TC","PingFang TC","BopomofoRuby","Microsoft JhengHei",sans-serif}
  #ytz-panel.ytz-top .ytz-cc{flex-direction:column;align-items:center;margin-right:6px}
  #ytz-panel.ytz-top .ytz-zy{writing-mode:horizontal-tb;text-orientation:mixed;font-size:${CFG.zhuyinTopFontSize};margin:0 0 2px 0;letter-spacing:.5px}
  .ytz-zy.ytz-poly{color:#e0b040}
  .ytz-zy.ytz-missing{color:#ff5555}
  .ytz-other{font-size:${CFG.hanFontSize};line-height:1;vertical-align:middle;margin-right:2px}
  .ytz-py{font-size:13px;color:var(--yt-spec-text-secondary,#aaa);margin-top:2px;font-family:Roboto,sans-serif}
  .ytz-en{font-size:14px;margin-top:4px;opacity:.9;font-family:Roboto,sans-serif}
  #ytz-panel.ytz-nopy .ytz-py{display:none}
  #ytz-panel.ytz-noen .ytz-en{display:none}
  `;
  function injectCss() {
    if (document.getElementById('ytz-css')) return;
    const s = document.createElement('style'); s.id = 'ytz-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  function renderZh(text, D) {
    const wrap = document.createElement('div'); wrap.className = 'ytz-zh';
    const py = [];
    for (const w of segment(text, D)) {
      if (w.zy[0] === null) {                       // non-dictionary (punctuation, latin, digits)
        const o = document.createElement('span'); o.className = 'ytz-other'; o.textContent = w.text; wrap.appendChild(o);
        if (w.text.trim()) py.push(w.text.trim());
        continue;
      }
      const word = document.createElement('span'); word.className = 'ytz-word';
      [...w.text].forEach((ch, i) => {
        const cc = document.createElement('span'); cc.className = 'ytz-cc';
        const han = document.createElement('span'); han.className = 'ytz-han'; han.textContent = ch;
        const zy = document.createElement('span'); zy.className = 'ytz-zy';
        const z = w.zy[i];
        if (z) { zy.textContent = normZhuyin(z); py.push(zhuyinToPinyin(z)); }
        else { zy.textContent = '?'; zy.classList.add('ytz-missing'); }
        if (w.alts && w.alts.length > 1) { zy.classList.add('ytz-poly'); cc.title = 'other readings: ' + w.alts.slice(1).map(normZhuyin).join(' / '); }
        cc.append(han, zy); word.appendChild(cc);
      });
      wrap.appendChild(word);
    }
    return { wrap, py: py.join(' ') };
  }

  function buildPanel(segs, en, meta, D, actions) {
    // actions.sources: [{value,label}], actions.source: current value, actions.setSource(value)
    injectCss();
    document.getElementById('ytz-panel')?._cleanup?.();
    document.getElementById('ytz-panel')?.remove();
    const panel = document.createElement('div'); panel.id = 'ytz-panel';
    panel.classList.toggle('ytz-nopy', !CFG.showPinyin);
    panel.classList.toggle('ytz-noen', !CFG.showEnglish);
    panel.classList.toggle('ytz-wordgap', CFG.wordGap);
    panel.classList.toggle('ytz-top', CFG.zhuyinLayout === 'top');

    const enModes = Object.keys(en).filter(k => en[k]?.length);
    const enMode0 = enModes.includes(CFG.englishDefault) ? CFG.englishDefault : enModes[0];
    const head = document.createElement('div'); head.id = 'ytz-head';
    const title = document.createElement('span'); title.className = 'ytz-title'; title.textContent = meta;
    const mkToggle = (id, label, checked) => { const l = document.createElement('label'); const i = document.createElement('input');
      i.type = 'checkbox'; i.id = id; i.checked = checked; l.append(i, document.createTextNode(label)); return l; };
    const enSel = document.createElement('select'); enSel.id = 'ytz-enmode';
    for (const m of enModes) { const o = document.createElement('option'); o.value = m; o.textContent = ({ native: 'native EN', translate: 'auto-translated', local: 'local MT' })[m] ?? m; o.selected = m === enMode0; enSel.appendChild(o); }
    const mkBtn = (label, title, fn) => { const b = document.createElement('button'); b.textContent = label; b.title = title; b.onclick = fn; return b; };
    if (actions.sources?.length) {
      const src = document.createElement('select'); src.title = 'transcript source';
      for (const o of actions.sources) { const e = document.createElement('option'); e.value = o.value; e.textContent = o.label; e.selected = o.value === actions.source; src.appendChild(e); }
      src.onchange = e => actions.setSource(e.target.value);
      head.append(title, src);
    } else head.append(title);
    head.append(mkToggle('ytz-top', 'zhuyin on top', CFG.zhuyinLayout === 'top'), mkToggle('ytz-py', 'pinyin', CFG.showPinyin), mkToggle('ytz-en', 'English', CFG.showEnglish), enSel, mkToggle('ytz-follow', 'follow', CFG.follow),
      mkBtn('↻', 'Refetch this video\'s transcript', actions.reload), mkBtn('✕ cache', 'Clear all cached transcripts and refetch', actions.clearAll), ...(actions.extra ?? []));
    panel.appendChild(head);

    const body = document.createElement('div'); body.id = 'ytz-body';
    const rows = [], enEls = [];
    const addRow = (seg) => {
      const row = document.createElement('div'); row.className = 'ytz-row';
      const ts = document.createElement('div'); ts.className = 'ytz-ts'; ts.textContent = fmtTime(seg.start);
      const col = document.createElement('div');
      const { wrap, py } = renderZh(seg.text, D);
      const pyEl = document.createElement('div'); pyEl.className = 'ytz-py'; pyEl.textContent = py;
      const enEl = document.createElement('div'); enEl.className = 'ytz-en';
      col.append(wrap, pyEl, enEl); row.append(ts, col);
      row.addEventListener('click', () => document.getElementById('movie_player')?.seekTo(seg.start, true));
      body.appendChild(row); rows.push(row); enEls.push(enEl);
    };
    segs.forEach(addRow);
    panel.appendChild(body);
    let enMode = enMode0;
    const applyEn = (mode) => { enMode = mode; const lines = en[mode] ?? []; enEls.forEach((el, i) => el.textContent = lines[i] ?? ''); };
    applyEn(enMode0);
    // append more segments later (progressive ASR) without rebuilding or losing scroll position
    panel._addSegs = (more, newEn, newMeta) => {
      more.forEach(seg => { segs.push(seg); addRow(seg); });
      if (newEn) {
        for (const [k, v] of Object.entries(newEn)) {
          if (v?.length && !en[k]?.length && ![...enSel.options].some(o => o.value === k)) {
            const o = document.createElement('option'); o.value = k; o.textContent = ({ native: 'native EN', translate: 'auto-translated', local: 'local MT' })[k] ?? k; enSel.appendChild(o);
            if (!en[enMode]?.length) { enMode = k; enSel.value = k; }
          }
        }
        Object.assign(en, newEn);
      }
      applyEn(enMode);
      if (newMeta !== undefined) title.textContent = newMeta;
    };

    head.querySelector('#ytz-top').onchange = e => panel.classList.toggle('ytz-top', e.target.checked);
    head.querySelector('#ytz-py').onchange = e => panel.classList.toggle('ytz-nopy', !e.target.checked);
    head.querySelector('#ytz-en').onchange = e => panel.classList.toggle('ytz-noen', !e.target.checked);
    head.querySelector('#ytz-follow').onchange = e => { CFG.follow = e.target.checked; };
    head.querySelector('#ytz-enmode').onchange = e => applyEn(e.target.value);

    (document.querySelector('#secondary-inner') || document.querySelector('#secondary')).prepend(panel);

    // Poll the player instead of binding to the <video> element: YouTube swaps the element on
    // quality/format changes, which silently orphans any timeupdate listener.
    const player = document.getElementById('movie_player');
    let active = -1;
    const tick = () => {
      const t = player?.getCurrentTime?.(); if (typeof t !== 'number') return;
      let idx = -1;
      for (let i = 0; i < segs.length; i++) { if (segs[i].start <= t) idx = i; else break; }
      if (idx === active) return;
      rows[active]?.classList.remove('ytz-active'); active = idx;
      if (idx >= 0) {
        rows[idx].classList.add('ytz-active');
        if (CFG.follow) {  // scroll the panel body only; scrollIntoView would also scroll the page
          const r = rows[idx];
          body.scrollTo({ top: r.offsetTop - body.clientHeight / 2 + r.offsetHeight / 2, behavior: 'smooth' });
        }
      }
    };
    const timer = setInterval(tick, CFG.pollMs);
    tick();
    panel._cleanup = () => clearInterval(timer);
  }

  function showStatus(msg, buttons = []) {
    injectCss();
    let panel = document.getElementById('ytz-panel');
    if (!panel) { panel = document.createElement('div'); panel.id = 'ytz-panel';
      (document.querySelector('#secondary-inner') || document.querySelector('#secondary'))?.prepend(panel); }
    panel.replaceChildren(); const d = document.createElement('div'); d.id = 'ytz-status'; d.textContent = msg;
    if (buttons.length) {
      const row = document.createElement('div'); row.id = 'ytz-head'; row.style.borderTop = '1px solid var(--yt-spec-10-percent-layer,#333)'; row.style.borderBottom = 'none';
      for (const [label, fn] of buttons) { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; row.appendChild(b); }
      panel.append(d, row);
    } else panel.appendChild(d);
  }

  // Re-chunk whisper word timestamps into short lines. Works at character level:
  //  - cuts only at dictionary-word boundaries (never inside 形成 / 塵埃 / 17公里)
  //  - scores every candidate boundary: punctuation, pause length, sentence-final particle before,
  //    clause-starter after; picks the best-scoring cut within [minChars, maxChars]
  //  - with no signal at all, cuts at the word boundary nearest maxChars
  const PARTICLES = new Set('了嗎呢吧啊喔嘛哦欸唷囉呀');
  const STARTERS = ['然後', '但是', '所以', '因為', '如果', '而且', '不過', '就是', '也就是', '可是', '只是', '還有', '另外',
    '比如', '例如', '其實', '當時', '現在', '這些', '那些', '這個', '那個', '這樣', '那樣', '我們', '你們', '他們', '它們',
    '這', '那', '它', '他', '她', '我', '你', '當', '在', '把', '讓', '等', '而', '並', '或', '或者', '還是', '甚至'];
  function chunkWords(words, D, maxChars = CFG.asrMaxChars, minChars = CFG.asrMinChars, gap = CFG.asrGapSec) {
    // flatten to characters with timing
    const chars = [];
    for (const w of words) for (const ch of [...w.text]) chars.push({ ch, start: w.start, end: w.end });
    if (!chars.length) return [];
    const text = chars.map(c => c.ch).join('');
    const boundary = new Set(); let pos = 0;
    for (const seg of segment(text, D)) { pos += [...seg.text].length; boundary.add(pos); }   // cut allowed after index pos-1
    const END = /[。？！?!…]/, SOFT = /[，、；：,;:]/, ALNUM = /[0-9A-Za-z.%]/;
    const startsWithStarter = (i) => STARTERS.some(st => text.startsWith(st, i));
    const scoreCut = (i) => {   // cut after char i
      if (!boundary.has(i + 1)) return -1;
      if (i + 1 < chars.length && ALNUM.test(chars[i].ch) && ALNUM.test(chars[i + 1].ch)) return -1;
      let sc = 0;
      if (END.test(chars[i].ch)) sc += 100; else if (SOFT.test(chars[i].ch)) sc += 40;
      if (i + 1 < chars.length) { const g = chars[i + 1].start - chars[i].end; if (g > 0) sc += Math.min(g / gap, 1) * 60; }
      if (PARTICLES.has(chars[i].ch)) sc += 25;
      if (i + 1 < chars.length && startsWithStarter(i + 1)) sc += 20;
      return sc;
    };
    const out = []; let lineStart = 0;
    while (lineStart < chars.length) {
      const hardEnd = Math.min(chars.length - 1, lineStart + maxChars - 1);
      let best = -1, bestScore = 0, fallback = -1;
      for (let i = lineStart; i <= hardEnd; i++) {
        const len = i - lineStart + 1, sc = scoreCut(i);
        if (sc < 0) continue;
        fallback = i;
        if (len < minChars && sc < 100) continue;
        if (sc >= 100) { best = i; break; }            // sentence end: always take it
        if (sc > bestScore || (sc === bestScore && sc > 0)) { best = i; bestScore = sc; }
      }
      if (best < 0) {                                  // no signal: nearest word boundary at/after the limit
        best = fallback;
        if (best < 0) { best = hardEnd; for (let i = hardEnd; i < chars.length; i++) if (boundary.has(i + 1)) { best = i; break; } }
      }
      const slice = chars.slice(lineStart, best + 1);
      out.push({ start: slice[0].start, end: slice.at(-1).end, text: slice.map(c => c.ch).join('') });
      lineStart = best + 1;
    }
    return out;
  }

  // English from the local server (opus-mt), with a browser-side translation memory (IndexedDB).
  // Returns null if the server is unavailable.
  async function translateLocal(texts) {
    if (!CFG.asrServer || !CFG.localTranslate || !texts.length) return null;
    const known = await mtGetMany(texts);
    const miss = [...new Set(texts.filter(t => !(t in known)))];
    if (miss.length) {
      try {
        const r = await fetch(`${CFG.asrServer}/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: miss }) });
        if (!r.ok) return null;
        const j = await r.json();
        if (!Array.isArray(j.lines)) return null;
        const pairs = miss.map((z, k) => [z, j.lines[k] ?? '']);
        pairs.forEach(([z, e]) => { known[z] = e; });
        mtPutMany(pairs);
      } catch (e) { log('local translate failed', e); return null; }
    }
    return texts.map(t => known[t] ?? '');
  }

  // Group consecutive lines into sentences: end at sentence punctuation, a long pause, or a length cap.
  // Returns [{first, last, text}] over line indices.
  function groupSentences(segs) {
    const END = /[。？！?!…]$/, out = [];
    let cur = null;
    segs.forEach((sg, i) => {
      if (!cur) cur = { first: i, last: i, text: sg.text };
      else { cur.last = i; cur.text += sg.text; }
      const next = segs[i + 1];
      const len = [...cur.text].length;
      if (END.test(sg.text.trim()) || !next || next.start - sg.end > CFG.sentenceGapSec || len >= CFG.sentenceMaxChars) { out.push(cur); cur = null; }
    });
    return out;
  }

  // Incremental translator for the current panel. Sentence mode: the English for a sentence is shown
  // under its first line; continuation lines get '↳'. Keeps an index-aligned array and only translates
  // units it hasn't seen, in order, so it works while transcription is still running.
  function makeLocalTranslator(vid) {
    let lines = [], seen = new Map(), chain = Promise.resolve();
    const push = () => { const p = document.getElementById('ytz-panel'); if (p?._addSegs && p._vid === vid) p._addSegs([], { local: lines.slice() }); };
    return {
      reset() { lines = []; seen = new Map(); },
      update(segs, done = true) {
        const units = CFG.translateUnit === 'sentence' ? groupSentences(segs) : segs.map((sg, i) => ({ first: i, last: i, text: sg.text }));
        // while ASR is still running, the last unit may still be growing: skip it unless it ends with punctuation
        const stable = units.filter((u, k) => done || k < units.length - 1 || /[。？！?!…]$/.test(u.text.trim()));
        const todo = stable.filter(u => seen.get(u.first) !== u.text);
        if (!todo.length) return;
        todo.forEach(u => { seen.set(u.first, u.text); for (let i = u.first; i <= u.last; i++) lines[i] = i === u.first ? (lines[i] || '') : '↳'; });
        for (let b = 0; b < todo.length; b += CFG.translateBatch) {
          const batch = todo.slice(b, b + CFG.translateBatch);
          chain = chain.then(async () => {
            const p = document.getElementById('ytz-panel'); if (!p || p._vid !== vid) return;   // navigated away
            const res = await translateLocal(batch.map(u => u.text));
            if (!res) return;
            batch.forEach((u, k) => { lines[u.first] = res[k]; });
            push();
          });
        }
      },
    };
  }

  // ---------------------------------------------------------------- local ASR fallback
  async function asrPath(vid, D, tracks, srcSel = {}) {
    const url = `${CFG.asrServer}/transcript/${vid}`;
    const actions = {
      reload: async () => { try { await fetch(url, { method: 'DELETE' }); } catch {} currentVideo = null; init(); },
      clearAll: async () => { await cacheClear(); await mtClear(); currentVideo = null; init(); },
      ...srcSel,
    };
    const retryBtn = ['retry', () => { currentVideo = null; init(); }];
    let shown = 0, lastJ = null;
    const tr = makeLocalTranslator(vid);
    // line-length slider: re-chunks instantly from cached words and rebuilds the panel
    const mkSlider = () => {
      const l = document.createElement('label'); l.title = 'max characters per line';
      const r = document.createElement('input'); r.type = 'range'; r.min = 6; r.max = 30; r.value = CFG.asrMaxChars;
      const v = document.createElement('span'); v.textContent = 'len ' + CFG.asrMaxChars;
      let tm; r.oninput = () => { CFG.asrMaxChars = +r.value; v.textContent = 'len ' + r.value; clearTimeout(tm);
        tm = setTimeout(() => { if (lastJ?.words?.length) { shown = 0; document.getElementById('ytz-panel')?._cleanup?.(); document.getElementById('ytz-panel')?.remove(); render(lastJ); } }, 150); };
      l.append(v, r); return l;
    };
    actions.extra = [mkSlider()];
    const render = (j) => {
      const segs = j.words?.length ? chunkWords(j.words, D) : (j.segs ?? []);
      const en = { translate: j.en?.length ? alignByOverlap(segs, j.en) : null, native: null };
      const meta = `ASR (whisper)${j.done ? '' : ` · ${Math.round((j.progress ?? 0) * 100)}%`}`;
      buildPanel(segs, en, meta, D, actions);
      const p = document.getElementById('ytz-panel'); p._vid = vid; p._lastStart = segs.at(-1)?.start ?? -1;
      shown = segs.length;
      tr.reset(); tr.update(segs, j.done);
    };
    while (currentVideo === vid) {
      let j;
      try { const r = await fetch(url); j = await r.json(); }
      catch (e) { showStatus(`No usable captions, and the local ASR server at ${CFG.asrServer} is not reachable. Start asr_server.py, or set CFG.asrServer = null.`, [retryBtn]); return; }
      if (j.status === 'error') { showStatus('ASR failed: ' + j.error, [retryBtn, ['retry (drop server cache)', actions.reload]]); return; }
      lastJ = j;
      const segs = j.words?.length ? chunkWords(j.words, D) : (j.segs ?? []);
      if (segs.length && (segs.length !== shown || j.done)) {
        const en = { translate: j.en?.length ? alignByOverlap(segs, j.en) : null, native: null };
        const meta = `ASR (whisper)${j.done ? '' : ` · ${Math.round((j.progress ?? 0) * 100)}%`}`;
        const panel = document.getElementById('ytz-panel');
        // word-chunked lines can change retroactively as more words arrive, so only append lines whose start is past everything shown
        const prevEnd = panel?._lastStart ?? -1;
        const fresh = segs.filter(x => x.start > prevEnd);
        if (panel?._addSegs && panel._vid === vid) { panel._addSegs(fresh, en, meta); panel._lastStart = segs.at(-1)?.start ?? prevEnd; }
        else { buildPanel(segs, en, meta, D, actions); const p = document.getElementById('ytz-panel'); p._vid = vid; p._lastStart = segs.at(-1)?.start ?? -1; }
        shown = segs.length;
        tr.update(segs, j.done);
      } else if (!segs.length) {
        showStatus(`Local ASR: ${j.status === 'paused' ? 'resuming' : j.status}${j.progress ? ` ${Math.round(j.progress * 100)}%` : ''}…`);
      }
      if (j.done) return;
      await sleep(CFG.asrPollMs);
    }
  }

  // ---------------------------------------------------------------- main
  let currentVideo = null;
  const forced = {};   // vid -> 'asr' | caption languageCode (user override from the source selector)
  async function init() {
    if (location.pathname !== '/watch') return;
    const vid = new URLSearchParams(location.search).get('v');
    if (!vid || vid === currentVideo) return;
    currentVideo = vid;
    const D = window.ZHUYIN_DICT;
    if (!D) { showStatus('ZHUYIN_DICT not loaded — check the @require URL.'); return; }

    showStatus('Loading transcript…');
    const player = await waitFor(() => { const p = document.getElementById('movie_player');
      return p?.getPlayerResponse?.()?.videoDetails?.videoId === vid ? p : null; });
    if (!player) { showStatus('Player not ready.'); return; }
    await waitFor(() => document.querySelector('#secondary-inner, #secondary'));

    // captions can show up in the player response a moment after the video id does
    await waitFor(() => player.getPlayerResponse()?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length, { tries: 12, every: 250 });
    const cap = player.getPlayerResponse().captions?.playerCaptionsTracklistRenderer;
    const tracks = cap?.captionTracks ?? [];
    log('tracks', tracks.map(t => t.languageCode + (t.kind === 'asr' ? '(asr)' : '')));
    const sources = [...tracks.map(t => ({ value: t.languageCode, label: `${trackName(t)}${t.kind === 'asr' ? ' (auto)' : ''}` })), { value: 'asr', label: 'whisper (local)' }];
    const setSource = (v) => { forced[vid] = v; currentVideo = null; init(); };
    const retryBtn = ['retry', () => { currentVideo = null; init(); }];
    const whisperBtn = ['use whisper', () => setSource('asr')];
    if (forced[vid] === 'asr') { if (CFG.asrServer) return asrPath(vid, D, tracks, { sources, source: 'asr', setSource }); showStatus('CFG.asrServer is not set.', [retryBtn]); return; }
    if (!tracks.length) { if (CFG.asrServer) return asrPath(vid, D, tracks, { sources, source: 'asr', setSource }); showStatus('No caption tracks found in the player response.', [retryBtn]); return; }
    const zh = (forced[vid] && tracks.find(t => t.languageCode === forced[vid])) || pickZhTrack(tracks);
    if (!zh) { if (CFG.asrServer) return asrPath(vid, D, tracks, { sources, source: 'asr', setSource }); showStatus('No Chinese track. Available: ' + tracks.map(trackName).join(', '), [retryBtn]); return; }
    const nativeEn = tracks.find(t => /^en/.test(t.languageCode) && t.kind !== 'asr') || tracks.find(t => /^en/.test(t.languageCode));
    const canTranslate = zh.isTranslatable !== false && (cap.translationLanguages ?? []).some(l => l.languageCode === 'en');

    const actions = {
      reload: async () => { await cacheDel(vid); currentVideo = null; init(); },
      clearAll: async () => { await cacheClear(); await mtClear(); currentVideo = null; init(); },
      sources, source: zh.languageCode, setSource,
    };
    try {
      let zhSegs, enT, enN, fromCache = false;
      const hit = await cacheGet(vid);
      if (hit && Date.now() - hit.t < CFG.cacheTtlMs && hit.zhLang === zh.languageCode && hit.enLang === (nativeEn?.languageCode ?? null)) {
        ({ zhSegs, enT, enN } = hit); fromCache = true;
        log('cache hit', vid, Math.round((Date.now() - hit.t) / 1000) + 's old');
      } else {
        const signed = await harvestTimedtextUrl(player, zh.languageCode, nativeEn?.languageCode);
        if (!signed) throw new Error('could not capture a signed timedtext URL from the player');
        [zhSegs, enT, enN] = await Promise.all([
          fetchTrack(signed, zh.languageCode),
          canTranslate ? fetchTrack(signed, zh.languageCode, 'en').catch(e => (log(e), [])) : [],
          nativeEn ? fetchTrack(signed, nativeEn.languageCode).catch(e => (log(e), [])) : [],
        ]);
        if (zhSegs.length) cachePut({ vid, t: Date.now(), zhLang: zh.languageCode, enLang: nativeEn?.languageCode ?? null, zhSegs, enT, enN });
      }
      log('zh', zhSegs.length, 'en-translate', enT.length, 'en-native', enN.length, fromCache ? '(cache)' : '(fetched)');
      if (!zhSegs.length) { showStatus('Chinese track empty.', [retryBtn, whisperBtn]); return; }
      const en = { native: enN.length ? alignByOverlap(zhSegs, enN) : null,
                   translate: enT.length ? alignByOverlap(zhSegs, enT) : null };
      buildPanel(zhSegs, en, `${trackName(zh)}${zh.kind === 'asr' ? ' (auto)' : ''}${fromCache ? ' ·cached' : ''}`, D, actions);
      document.getElementById('ytz-panel')._vid = vid;
      if (!en.native && !en.translate) makeLocalTranslator(vid).update(zhSegs);
    } catch (e) { console.error('[yt-zhuyin]', e); showStatus('Failed: ' + e.message, [retryBtn, whisperBtn]); }
  }

  window.addEventListener('yt-navigate-finish', () => { currentVideo = null; init(); });
  init();
})();