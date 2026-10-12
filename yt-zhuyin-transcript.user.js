// ==UserScript==
// @name         YouTube 注音 transcript (zh-TW + zhuyin, pinyin optional, English)
// @namespace    local.yt-zhuyin
// @version      0.8.2
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
    autoHideHead: true,         // slide the panel toolbar away after autoHideMs without mouse movement; hover brings it back
    autoHideMs: 3000,
    wordGap: true,              // visible gap between dictionary words
    restoreCaptions: true,      // put player captions back to whatever they were after harvesting
    panelMaxHeight: '60vh',
    panelMode: 'side',          // 'side' (recommendations column) | 'below' (under the video) | 'overlay' (floating, draggable); the header selector remembers your choice
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
    translateUnit: 'line',      // 'line': each caption line on its own, lines up with the Chinese | 'sentence': group lines into sentences first (English on the first line; reads better)
    sentenceMaxChars: 60,       // sentence grouping: force a break after this many Chinese cells (a latin letter counts 1/3)
    sentenceGapSec: 1.5,        // sentence grouping: a pause longer than this ends a sentence
    mtCacheMax: 20000,          // translated lines kept in IndexedDB (oldest evicted)         // lines per /translate request; smaller = English shows up sooner on long videos
    asrMaxChars: 14,            // re-chunk whisper word timestamps into lines of at most this many Chinese cells (a latin letter counts 1/3)
    asrMinChars: 4,             // don't cut on a pause before this many Chinese cells
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

  // Display width in "Chinese cells": a CJK character with its zhuyin column is 1; a latin letter,
  // digit or space is about a third of that. Line-length limits are expressed in these units.
  const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;
  const charWidth = (ch) => CJK.test(ch) ? 1 : 1 / 3;
  const textWidth = (text) => { let w = 0; for (const ch of text) w += charWidth(ch); return w; };
  // ---------------------------------------------------------------- icons
  // Lucide-style strokes on a 24px grid. Built with createElementNS because YouTube
  // enforces Trusted Types: innerHTML with a plain string throws there.
  const ring = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
  const FRAME = 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z';
  const ICONS = {
    refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
    trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
    stop: 'M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
    play: 'M7 4.5v15l12-7.5z',
    follow: ring(12, 12, 3) + 'M12 2v4M12 18v4M2 12h4M18 12h4',
    lang: 'm5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6',
    pinyin: 'M6 3h12' + ring(11, 14.5, 5.5) + 'M16.5 9v11',                   // ā
    zyTop: 'M6 4h12M5 9h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z',   // reading above the character
    byLine: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    width: 'M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4',
    autoHide: 'M5 4h14M18 15l-6-6-6 6M12 9v11',                            // toolbar tucks away upwards
    alpha: 'M12 2.7 6.3 8.4a8 8 0 1 0 11.4 0z',
    side: FRAME + 'M15 3v18',
    below: FRAME + 'M3 15h18',
    overlay: FRAME + 'M13 12h5v5h-5z',
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor',
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', ICONS[name]); svg.appendChild(p);
    return svg;
  }
  function iconBtn(name, title, onclick) {
    const b = document.createElement('button'); b.className = 'ytz-ib'; b.title = title; b.setAttribute('aria-label', title);
    b.appendChild(icon(name)); b.onclick = onclick; return b;
  }
  // pressed state lives in aria-pressed, which the CSS also styles
  function toggleBtn(name, title, on, onchange) {
    const b = iconBtn(name, title, () => { const v = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', v); onchange(v); });
    b.setAttribute('aria-pressed', !!on); return b;
  }
  const group = (...els) => { const g = document.createElement('span'); g.className = 'ytz-grp-i'; g.append(...els.filter(Boolean)); return g; };
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
  #ytz-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 10px 8px 14px;border-bottom:1px solid var(--yt-spec-10-percent-layer,#333);font:13px Roboto,"Noto Sans TC",sans-serif}
  #ytz-head .ytz-title{font-weight:500;font-size:14px;margin-right:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  #ytz-head .ytz-tools{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px}
  #ytz-head .ytz-grp-i{display:inline-flex;align-items:center;gap:2px}
  #ytz-head .ytz-grp-i + .ytz-grp-i{border-left:1px solid var(--yt-spec-10-percent-layer,#333);padding-left:10px}
  #ytz-head label{display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none;color:var(--yt-spec-text-secondary,#aaa)}
  #ytz-head label svg{width:16px;height:16px}
  .ytz-ib{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--yt-spec-text-secondary,#aaa);cursor:pointer}
  .ytz-ib:hover{background:var(--yt-spec-badge-chip-background,#272727);color:var(--yt-spec-text-primary,#f1f1f1)}
  .ytz-ib[aria-pressed=true]{color:#ff4e6a;background:rgba(255,0,51,.12)}
  .ytz-ib.ytz-danger:hover{color:#ff5555}
  #ytz-head .ytz-txt{background:var(--yt-spec-badge-chip-background,#272727);color:inherit;border:0;border-radius:16px;padding:5px 12px;cursor:pointer;font:inherit;font-weight:500}
  #ytz-head .ytz-txt:hover{background:var(--yt-spec-10-percent-layer,#3f3f3f)}
  #ytz-head input[type=range]{width:80px;accent-color:#ff0033}
  #ytz-head .ytz-val{font-variant-numeric:tabular-nums;min-width:2ch;font-size:12px}
  #ytz-head select{background:var(--yt-spec-badge-chip-background,#272727);color:inherit;border:0;border-radius:8px;padding:5px 8px;font:inherit;cursor:pointer}
  #ytz-status{padding:10px 12px;font-size:13px;color:var(--yt-spec-text-secondary,#aaa)}
  #ytz-body{position:relative;max-height:${CFG.panelMaxHeight};overflow-y:auto}
  .ytz-row{display:grid;grid-template-columns:52px 1fr;gap:8px;padding:8px 12px;cursor:pointer;border-left:3px solid transparent}
  .ytz-row:hover{background:var(--yt-spec-badge-chip-background,#272727)}
  .ytz-row.ytz-grp{border-left-color:rgba(232,179,57,.35)}
  .ytz-row.ytz-active{border-left-color:#ff0033;background:var(--yt-spec-badge-chip-background,#272727)}
  .ytz-ts{font-size:12px;color:var(--yt-spec-text-secondary,#aaa);padding-top:6px;font-variant-numeric:tabular-nums}
  .ytz-zh{line-height:1.15}
  .ytz-word{display:inline-flex;align-items:center;margin:0 ${CFG.wordGap ? 7 : 2}px 4px 0;vertical-align:middle;border-bottom:1px dotted transparent}
  #ytz-panel.ytz-wordgap .ytz-word{border-bottom-color:var(--yt-spec-10-percent-layer,#444)}
  .ytz-cc{display:inline-flex;align-items:center;margin-right:3px}
  .ytz-han{font-size:${CFG.hanFontSize};line-height:1}
  .ytz-zy{writing-mode:vertical-lr;text-orientation:upright;font-size:${CFG.zhuyinFontSize};line-height:1;margin-left:2px;color:var(--yt-spec-text-secondary,#aaa);white-space:nowrap;font-family:"Noto Sans TC","PingFang TC","BopomofoRuby","Microsoft JhengHei",sans-serif}
  #ytz-panel.ytz-top .ytz-cc{flex-direction:column-reverse;align-items:center;margin-right:6px}
  #ytz-panel.ytz-top .ytz-zy{writing-mode:horizontal-tb;text-orientation:mixed;font-size:${CFG.zhuyinTopFontSize};margin:0 0 2px 0;letter-spacing:.5px}
  .ytz-zy.ytz-poly{color:#e0b040}
  .ytz-zy.ytz-missing{color:#ff5555}
  .ytz-other{font-size:${CFG.hanFontSize};line-height:1;vertical-align:middle;margin-right:2px}
  .ytz-py{font-size:13px;color:var(--yt-spec-text-secondary,#aaa);margin-top:2px;font-family:Roboto,sans-serif}
  .ytz-en{font-size:14px;margin-top:4px;opacity:.9;font-family:Roboto,sans-serif}
  #ytz-panel.ytz-nopy .ytz-py{display:none}
  #ytz-panel.ytz-noen .ytz-en{display:none}
  #ytz-panel.ytz-below{margin:12px 0;background:var(--yt-spec-raised-background,#212121);border-color:transparent;box-shadow:inset 3px 0 0 #ff0033}
  #ytz-panel.ytz-below #ytz-body{max-height:none}
  html.ytz-nomast #masthead-container{transform:translateY(calc(-100% + 6px));transition:transform .2s ease .4s}
  html.ytz-nomast #masthead-container:hover{transform:none;transition-delay:0s}
  html.ytz-nomast #page-manager{margin-top:0!important}
  #ytz-panel.ytz-overlay{position:fixed;z-index:2147483647;display:flex;flex-direction:column;margin:0;min-width:280px;min-height:120px;resize:both;color:#f1f1f1;background:rgba(15,15,15,var(--ytz-alpha,.8));backdrop-filter:blur(6px);box-shadow:0 4px 24px rgba(0,0,0,.5)}
  #ytz-panel.ytz-overlay #ytz-head{cursor:move;touch-action:none;user-select:none}
  #ytz-panel.ytz-overlay #ytz-body{max-height:none;flex:1;min-height:0}
  #ytz-panel.ytz-overlay .ytz-ts,#ytz-panel.ytz-overlay .ytz-zy,#ytz-panel.ytz-overlay .ytz-py,#ytz-panel.ytz-overlay #ytz-status{color:#bbb}
  #ytz-panel.ytz-overlay .ytz-zy.ytz-poly{color:#e0b040}
  #ytz-panel.ytz-overlay .ytz-row:hover,#ytz-panel.ytz-overlay .ytz-row.ytz-active,#ytz-panel.ytz-overlay #ytz-head button:hover{background:rgba(255,255,255,.1)}
  #ytz-panel:not(.ytz-overlay) .ytz-alpha-g{display:none}
  /* auto-hide: the toolbar floats over the top lines and slides up out of the panel when idle */
  #ytz-panel.ytz-autohide:not(.ytz-overlay){position:relative}
  #ytz-panel.ytz-autohide #ytz-head{position:absolute;top:0;left:0;right:0;z-index:2;background:var(--ytz-head-bg,var(--yt-spec-base-background,#0f0f0f));box-shadow:0 4px 16px rgba(0,0,0,.6);backdrop-filter:blur(14px) brightness(.6);transition:transform .25s ease,opacity .25s ease}
  #ytz-panel.ytz-autohide.ytz-idle #ytz-head{transform:translateY(-100%);opacity:0;pointer-events:none}
  #ytz-panel.ytz-below{--ytz-head-bg:var(--yt-spec-raised-background,#212121)}
  #ytz-panel.ytz-overlay{--ytz-head-bg:rgba(8,8,8,.93)}   /* dark enough on its own; the blur on top turns any line underneath to smudge */
  `;
  function injectCss() {
    if (document.getElementById('ytz-css')) return;
    const s = document.createElement('style'); s.id = 'ytz-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- placement
  // 'side': top of the recommendations column (YouTube's own transcript lives there too)
  // 'below': under the video, full primary width — wide and readable, especially in theater mode
  // 'overlay': floating box, dragged by its header, resized from the corner, translucent; follows the player into fullscreen
  const UI_KEY = 'ytz-ui';
  const ui = Object.assign({ mode: CFG.panelMode, x: 24, y: 80, w: 560, h: 360, alpha: 0.8 },
    (() => { try { return JSON.parse(localStorage.getItem(UI_KEY)) ?? {}; } catch { return {}; } })());
  const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch {} };
  // display toggles live in the same localStorage entry; CFG holds the defaults until the first change
  const PREFS = ['zhuyinLayout', 'showPinyin', 'showEnglish', 'follow', 'translateUnit', 'asrMaxChars', 'autoHideHead'];
  for (const k of PREFS) if (k in ui) CFG[k] = ui[k];
  const setPref = (k, v) => { CFG[k] = v; ui[k] = v; saveUi(); };
  function mountPanel(panel) {
    panel.classList.remove('ytz-below', 'ytz-overlay');
    panel.style.cssText = '';
    if (ui.mode === 'overlay') {
      panel.classList.add('ytz-overlay');
      ui.x = Math.max(0, Math.min(ui.x, innerWidth - 120)); ui.y = Math.max(0, Math.min(ui.y, innerHeight - 60));   // never off screen
      Object.assign(panel.style, { left: ui.x + 'px', top: ui.y + 'px', width: ui.w + 'px', height: ui.h + 'px' });
      panel.style.setProperty('--ytz-alpha', ui.alpha);
      const fs = document.fullscreenElement;
      (fs && fs !== document.documentElement && fs !== document.body ? fs : document.body).appendChild(panel);
      syncBelow();
      return;
    }
    // querySelector with a selector list returns the first match in document order, and #primary-inner
    // comes before #below: ask for #below on its own, or the panel lands above the video
    const host = (ui.mode === 'below' && (document.querySelector('ytd-watch-flexy #below') || document.querySelector('#below')))
      || document.querySelector('#secondary-inner') || document.querySelector('#secondary');
    if (ui.mode === 'below') panel.classList.add('ytz-below');
    host?.prepend(panel);
    syncBelow();
  }
  function makeOverlayControls(panel, head) {
    // placement: three icon buttons, one pressed; the opacity slider only shows in overlay mode
    const modes = [['side', 'Beside the video'], ['below', 'Below the video (fits the screen, hides the YouTube header)'],
      ['overlay', 'Floating overlay: drag the header, resize from the corner']];
    const btns = modes.map(([m, title]) => {
      const b = iconBtn(m, title, () => { ui.mode = m; saveUi(); mountPanel(panel); btns.forEach(x => x.setAttribute('aria-pressed', x === b)); });
      b.setAttribute('aria-pressed', m === ui.mode); return b;
    });
    const al = document.createElement('label'); al.id = 'ytz-alpha'; al.title = 'Overlay opacity';
    const ar = document.createElement('input'); ar.type = 'range'; ar.min = 0.2; ar.max = 1; ar.step = 0.05; ar.value = ui.alpha;
    ar.oninput = () => { ui.alpha = +ar.value; panel.style.setProperty('--ytz-alpha', ui.alpha); saveUi(); };
    al.append(icon('alpha'), ar);
    // drag by the header (not by its controls)
    head.addEventListener('pointerdown', e => {
      if (!panel.classList.contains('ytz-overlay') || e.button !== 0 || e.target.closest('input,select,button,label')) return;
      const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = ev => { ui.x = Math.max(0, Math.min(innerWidth - 120, ev.clientX - dx)); ui.y = Math.max(0, Math.min(innerHeight - 60, ev.clientY - dy));
        panel.style.left = ui.x + 'px'; panel.style.top = ui.y + 'px'; };
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); saveUi(); };
      head.setPointerCapture(e.pointerId); head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
      e.preventDefault();
    });
    // remember the size after a corner resize
    let tm; const ro = new ResizeObserver(() => { if (!panel.classList.contains('ytz-overlay')) return; clearTimeout(tm);
      tm = setTimeout(() => { ui.w = Math.round(panel.offsetWidth); ui.h = Math.round(panel.offsetHeight); saveUi(); }, 300); });
    ro.observe(panel);
    // inside the fullscreen player, don't let clicks/keys in the panel reach the player (play/pause, shortcuts)
    for (const ev of ['click', 'dblclick', 'mousedown', 'mouseup', 'keydown', 'keyup', 'keypress', 'contextmenu']) panel.addEventListener(ev, e => e.stopPropagation());
    const alg = group(al); alg.classList.add('ytz-alpha-g');
    return [group(...btns), alg];
  }
  // the overlay has to be re-parented into the fullscreen element to stay visible; YouTube swaps that element on every toggle
  document.addEventListener('fullscreenchange', () => { const p = document.getElementById('ytz-panel'); if (p && ui.mode === 'overlay') mountPanel(p); syncBelow(); });

  // Below mode: YouTube's fixed masthead eats the top of the screen, so reading the panel used to mean
  // scrolling the top of the video away. Hide the masthead (hover the top edge to get it back) and give
  // the panel exactly the height left under the player, so video and panel fit with no page scroll.
  function syncBelow() {
    const panel = document.getElementById('ytz-panel');
    const on = ui.mode === 'below' && location.pathname === '/watch' && !!panel?.isConnected && !document.fullscreenElement;
    document.documentElement.classList.toggle('ytz-nomast', on);
    const body = panel?.querySelector('#ytz-body');
    if (!body) return;
    if (!on) { body.style.height = ''; return; }
    requestAnimationFrame(() => {
      const top = body.getBoundingClientRect().top + scrollY;   // where the body starts with the page at the top
      body.style.height = Math.max(160, innerHeight - top - 14) + 'px';
    });
  }
  let fitTm;
  const fitSoon = () => { clearTimeout(fitTm); fitTm = setTimeout(syncBelow, 120); };
  window.addEventListener('resize', fitSoon);
  // theater / default mode resize the player without resizing the window
  waitFor(() => document.getElementById('movie_player')).then(p => p && new ResizeObserver(fitSoon).observe(p));

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
    const enName = (m) => ({ native: 'native EN', translate: 'auto-translated', local: 'local MT' })[m] ?? m;
    const enSel = document.createElement('select'); enSel.title = 'Which English';
    for (const m of enModes) { const o = document.createElement('option'); o.value = m; o.textContent = enName(m); o.selected = m === enMode0; enSel.appendChild(o); }
    const showEnSel = () => { enSel.style.display = enSel.options.length > 1 ? '' : 'none'; };
    showEnSel();
    head.append(title);
    if (actions.sources?.length) {
      const src = document.createElement('select'); src.title = 'Transcript source';
      for (const o of actions.sources) { const e = document.createElement('option'); e.value = o.value; e.textContent = o.label; e.selected = o.value === actions.source; src.appendChild(e); }
      src.onchange = e => actions.setSource(e.target.value);
      head.append(src);
    }
    // display toggles write back to CFG so a rebuilt panel (source switch, line length) keeps them
    const tools = document.createElement('div'); tools.className = 'ytz-tools';
    tools.append(
      group(
        toggleBtn('zyTop', 'Zhuyin above the characters', CFG.zhuyinLayout === 'top', v => { setPref('zhuyinLayout', v ? 'top' : 'side'); panel.classList.toggle('ytz-top', v); }),
        toggleBtn('pinyin', 'Pinyin', CFG.showPinyin, v => { setPref('showPinyin', v); panel.classList.toggle('ytz-nopy', !v); }),
        toggleBtn('lang', 'English', CFG.showEnglish, v => { setPref('showEnglish', v); panel.classList.toggle('ytz-noen', !v); }),
        enSel,
        // local MT only: off = whole sentences (read better), on = line by line (lines up with the Chinese)
        actions.retranslate && toggleBtn('byLine', 'Local MT: translate line by line instead of whole sentences', CFG.translateUnit === 'line', v => actions.retranslate(v ? 'line' : 'sentence')),
      ),
      group(toggleBtn('follow', 'Follow playback', CFG.follow, v => setPref('follow', v)), ...(actions.extra ?? [])),
      group(toggleBtn('autoHide', 'Auto-hide this toolbar when the mouse is idle', CFG.autoHideHead, v => { setPref('autoHideHead', v); panel.classList.toggle('ytz-autohide', v); wake(); })),
      group(...(actions.asr ?? []),
        iconBtn('refresh', 'Refetch this video\'s transcript', actions.reload),
        Object.assign(iconBtn('trash', 'Clear all cached transcripts and translations, then refetch', actions.clearAll), { className: 'ytz-ib ytz-danger' })),
      ...makeOverlayControls(panel, head));
    head.append(tools);
    panel.appendChild(head);
    // Auto-hide: any mouse movement over the panel shows the toolbar; it tucks away after autoHideMs of
    // stillness, but never from under the pointer or while one of its dropdowns has focus.
    panel.classList.toggle('ytz-autohide', CFG.autoHideHead);
    let idleTm;
    const tuck = () => { if (head.matches(':hover, :focus-within')) idleTm = setTimeout(tuck, CFG.autoHideMs); else panel.classList.add('ytz-idle'); };
    const wake = () => { panel.classList.remove('ytz-idle'); clearTimeout(idleTm); idleTm = setTimeout(tuck, CFG.autoHideMs); };
    panel.addEventListener('pointermove', wake);
    panel.addEventListener('pointerleave', () => { clearTimeout(idleTm); idleTm = setTimeout(tuck, 800); });
    wake();

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
    // '↳' marks a line continuing the sentence translated above it: blank the text and
    // bracket the whole group instead, so the English visibly belongs to those lines.
    const applyEn = (mode) => {
      enMode = mode;
      const lines = en[mode] ?? [];
      const cont = (i) => (lines[i] ?? '') === '↳';
      enEls.forEach((el, i) => {
        el.textContent = cont(i) ? '' : (lines[i] ?? '');
        rows[i].classList.toggle('ytz-grp', cont(i) || cont(i + 1));
      });
    };
    applyEn(enMode0);
    // append more segments later (progressive ASR) without rebuilding or losing scroll position
    panel._addSegs = (more, newEn, newMeta) => {
      more.forEach(seg => { segs.push(seg); addRow(seg); });
      if (newEn) {
        for (const [k, v] of Object.entries(newEn)) {
          if (v?.length && !en[k]?.length && ![...enSel.options].some(o => o.value === k)) {
            const o = document.createElement('option'); o.value = k; o.textContent = enName(k); enSel.appendChild(o); showEnSel();
            if (!en[enMode]?.length) { enMode = k; enSel.value = k; }
          }
        }
        Object.assign(en, newEn);
      }
      applyEn(enMode);
      if (newMeta !== undefined) title.textContent = newMeta;
    };

    enSel.onchange = e => applyEn(e.target.value);

    mountPanel(panel);

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
    panel._cleanup = () => { clearInterval(timer); clearTimeout(idleTm); };
  }

  function showStatus(msg, buttons = []) {
    injectCss();
    // always a fresh element: a reused one would keep the old panel's _addSegs/_owner and its highlight timer,
    // and a later source switch would append lines into a body that is no longer in the page
    const old = document.getElementById('ytz-panel'); old?._cleanup?.(); old?.remove();
    const panel = document.createElement('div'); panel.id = 'ytz-panel';
    mountPanel(panel);
    const d = document.createElement('div'); d.id = 'ytz-status'; d.textContent = msg;
    if (buttons.length) {
      const row = document.createElement('div'); row.id = 'ytz-head'; row.style.borderTop = '1px solid var(--yt-spec-10-percent-layer,#333)'; row.style.borderBottom = 'none';
      for (const [label, fn] of buttons) { const b = document.createElement('button'); b.className = 'ytz-txt'; b.textContent = label; b.onclick = fn; row.appendChild(b); }
      const tools = document.createElement('div'); tools.className = 'ytz-tools'; tools.style.marginLeft = 'auto';
      tools.append(...makeOverlayControls(panel, row)); row.append(tools);
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
    // whisper's word tokens arrive stripped, so put a space back between two adjacent latin words
    const chars = [], LATIN = /[0-9A-Za-z]/;
    for (const w of words) {
      if (chars.length && LATIN.test(chars.at(-1).ch) && LATIN.test([...w.text][0] ?? '')) chars.push({ ch: ' ', start: w.start, end: w.start });
      for (const ch of [...w.text]) chars.push({ ch, start: w.start, end: w.end });
    }
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
      // limits are in Chinese cells: walk forward accumulating display width instead of counting characters
      let hardEnd = lineStart, width = charWidth(chars[lineStart].ch);
      while (hardEnd + 1 < chars.length && width + charWidth(chars[hardEnd + 1].ch) <= maxChars) width += charWidth(chars[++hardEnd].ch);
      let best = -1, bestScore = 0, fallback = -1, len = 0;
      for (let i = lineStart; i <= hardEnd; i++) {
        len += charWidth(chars[i].ch);
        const sc = scoreCut(i);
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
      out.push({ start: slice[0].start, end: slice.at(-1).end, text: slice.map(c => c.ch).join('').trim() });
      lineStart = best + 1;
    }
    return out;
  }

  // English from the local server (opus-mt), with a browser-side translation memory (IndexedDB).
  // Returns null if the server is unavailable.
  async function translateLocal(texts) {
    if (!CFG.asrServer || !CFG.localTranslate || !texts.length) return null;
    const known = await mtGetMany(texts);   // Map: zh -> en
    const miss = [...new Set(texts.filter(t => !known.has(t)))];
    if (miss.length) {
      try {
        const r = await fetch(`${CFG.asrServer}/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: miss }) });
        if (!r.ok) return null;
        const j = await r.json();
        if (!Array.isArray(j.lines)) return null;
        const pairs = miss.map((z, k) => [z, j.lines[k] ?? '']);
        pairs.forEach(([z, e]) => known.set(z, e));
        mtPutMany(pairs.filter(([, e]) => e));   // don't memorise an empty answer
      } catch (e) { log('local translate failed', e); return null; }
    }
    return texts.map(t => known.get(t) ?? '');
  }

  // Group consecutive lines into sentences: end at sentence punctuation, a long pause, or a length cap.
  // Returns [{first, last, text}] over line indices.
  function groupSentences(segs) {
    const END = /[。？！?!…]$/, out = [];
    let cur = null;
    segs.forEach((sg, i) => {
      if (!cur) cur = { first: i, last: i, text: sg.text };
      else { cur.last = i; cur.text += (/[0-9A-Za-z]$/.test(cur.text) && /^[0-9A-Za-z]/.test(sg.text) ? ' ' : '') + sg.text; }   // keep a space between latin words across lines
      const next = segs[i + 1];
      const len = textWidth(cur.text);
      if (END.test(sg.text.trim()) || !next || next.start - sg.end > CFG.sentenceGapSec || len >= CFG.sentenceMaxChars) { out.push(cur); cur = null; }
    });
    return out;
  }

  // Incremental translator for the current panel. Sentence mode: the English for a sentence is shown
  // under its first line; continuation lines get '↳'. Keeps an index-aligned array and only translates
  // units it hasn't seen, in order, so it works while transcription is still running.
  // `owner` is the token the caller stamps on its panel (_owner): the video id alone can't tell a
  // caption-track panel from a whisper panel for the same video.
  function makeLocalTranslator(owner) {
    let lines = [], seen = new Map(), chain = Promise.resolve(), lastSegs = [], lastDone = true;
    const push = () => { const p = document.getElementById('ytz-panel'); if (p?._addSegs && p._owner === owner) p._addSegs([], { local: lines.slice() }); };
    const reset = () => { lines = []; seen = new Map(); };
    const update = (segs, done = true) => {
      lastSegs = segs; lastDone = done;
      const units = CFG.translateUnit === 'sentence' ? groupSentences(segs) : segs.map((sg, i) => ({ first: i, last: i, text: sg.text }));
      // while ASR is still running, the last unit may still be growing: skip it unless it ends with punctuation
      const stable = units.filter((u, k) => done || k < units.length - 1 || /[。？！?!…]$/.test(u.text.trim()));
      const todo = stable.filter(u => seen.get(u.first) !== u.text);
      if (!todo.length) return;
      todo.forEach(u => { seen.set(u.first, u.text); for (let i = u.first; i <= u.last; i++) lines[i] = i === u.first ? (lines[i] || '') : '↳'; });
      for (let b = 0; b < todo.length; b += CFG.translateBatch) {
        const batch = todo.slice(b, b + CFG.translateBatch);
        chain = chain.then(async () => {
          const p = document.getElementById('ytz-panel'); if (!p || p._owner !== owner) return;   // navigated away or source switched
          const res = await translateLocal(batch.map(u => u.text));
          if (!res) return;
          batch.forEach((u, k) => { lines[u.first] = res[k]; });
          push();
        });
      }
    };
    // Re-translate everything under a different unit. Sentence mode reads better;
    // line mode lines up 1:1 with the Chinese.
    const setUnit = (unit) => { setPref('translateUnit', unit); reset(); push(); update(lastSegs, lastDone); };
    return { reset, update, setUnit };
  }

  // ---------------------------------------------------------------- local ASR fallback
  async function asrPath(vid, D, tracks, srcSel = {}) {
    const url = `${CFG.asrServer}/transcript/${vid}`;
    const actions = {
      reload: async () => { try { await fetch(url, { method: 'DELETE' }); } catch {} currentVideo = null; init(); },
      clearAll: async () => { await cacheClear(); await mtClear(); currentVideo = null; init(); },
      ...srcSel,
    };
    // resume / retry go through /start: a plain poll never restarts a stopped or failed job
    const resume = async () => { try { await fetch(`${CFG.asrServer}/job/${vid}/start`, { method: 'POST' }); } catch {} currentVideo = null; init(); };
    const retryBtn = ['retry', resume];
    // one button, two states: stop while the server works on it, resume once stopped
    const asrBtn = iconBtn('stop', '', null);
    const setRunning = (running) => {
      asrBtn.replaceChildren(icon(running ? 'stop' : 'play'));
      asrBtn.title = running ? 'Stop transcribing (keeps what is done)' : 'Resume transcribing';
      asrBtn.setAttribute('aria-label', asrBtn.title);
      asrBtn.onclick = running ? async () => { try { await fetch(`${CFG.asrServer}/job/${vid}/stop`, { method: 'POST' }); } catch {} } : resume;
    };
    setRunning(true);
    actions.asr = [asrBtn];
    let shown = 0, lastJ = null;
    const owner = Symbol(vid);   // identifies panels built by this run (see makeLocalTranslator)
    const tr = makeLocalTranslator(owner);
    actions.retranslate = (unit) => tr.setUnit(unit);
    // line-length slider: re-chunks instantly from cached words and rebuilds the panel
    const mkSlider = () => {
      const l = document.createElement('label'); l.title = 'Max characters per line';
      const r = document.createElement('input'); r.type = 'range'; r.min = 6; r.max = 30; r.value = CFG.asrMaxChars;
      const v = document.createElement('span'); v.className = 'ytz-val'; v.textContent = CFG.asrMaxChars;
      let tm; r.oninput = () => { setPref('asrMaxChars', +r.value); v.textContent = r.value; clearTimeout(tm);
        tm = setTimeout(() => { if (lastJ?.words?.length) { shown = 0; document.getElementById('ytz-panel')?._cleanup?.(); document.getElementById('ytz-panel')?.remove(); render(lastJ); } }, 150); };
      l.append(icon('width'), r, v); return l;
    };
    actions.extra = [mkSlider()];
    const asrMeta = (j) => `ASR (whisper)${j.done ? '' : ` · ${j.status === 'stopped' ? 'stopped at ' : ''}${Math.round((j.progress ?? 0) * 100)}%`}`;
    const render = (j) => {
      const segs = j.words?.length ? chunkWords(j.words, D) : (j.segs ?? []);
      const en = { translate: j.en?.length ? alignByOverlap(segs, j.en) : null, native: null };
      const meta = asrMeta(j);
      buildPanel(segs, en, meta, D, actions);
      const p = document.getElementById('ytz-panel'); p._owner = owner; p._lastStart = segs.at(-1)?.start ?? -1;
      shown = segs.length;
      tr.reset(); tr.update(segs, j.done);
    };
    while (currentVideo === vid) {
      let j;
      try { const r = await fetch(url); j = await r.json(); }
      catch (e) { showStatus(`No usable captions, and the local ASR server at ${CFG.asrServer} is not reachable. Start asr_server.py, or set CFG.asrServer = null.`, [retryBtn]); return; }
      if (j.status === 'error') { showStatus('ASR failed: ' + j.error, [retryBtn, ['start over', actions.reload]]); return; }
      const stopped = j.status === 'stopped';
      setRunning(!stopped);
      if (j.done) { asrBtn.remove(); actions.asr = []; }
      lastJ = j;
      const segs = j.words?.length ? chunkWords(j.words, D) : (j.segs ?? []);
      if (segs.length && (segs.length !== shown || j.done || stopped)) {
        const en = { translate: j.en?.length ? alignByOverlap(segs, j.en) : null, native: null };
        const meta = asrMeta(j);
        const panel = document.getElementById('ytz-panel');
        // word-chunked lines can change retroactively as more words arrive, so only append lines whose start is past everything shown
        const prevEnd = panel?._lastStart ?? -1;
        const fresh = segs.filter(x => x.start > prevEnd);
        if (panel?._addSegs && panel._owner === owner) { panel._addSegs(fresh, en, meta); panel._lastStart = segs.at(-1)?.start ?? prevEnd; }
        else { buildPanel(segs, en, meta, D, actions); const p = document.getElementById('ytz-panel'); p._owner = owner; p._lastStart = segs.at(-1)?.start ?? -1; }
        shown = segs.length;
        tr.update(segs, j.done);
      } else if (!segs.length && stopped) {
        showStatus('Local ASR stopped before the first line.', [['resume', resume]]);
      } else if (!segs.length) {
        showStatus(`Local ASR: ${j.status === 'paused' ? 'resuming' : j.status}${j.progress ? ` ${Math.round(j.progress * 100)}%` : ''}…`);
      }
      if (j.done || stopped) return;
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
      // the local translator only runs when YouTube gave us no English at all
      const owner = Symbol(vid);
      const tr = (!en.native && !en.translate) ? makeLocalTranslator(owner) : null;
      if (tr) actions.retranslate = (unit) => tr.setUnit(unit);
      buildPanel(zhSegs, en, `${trackName(zh)}${zh.kind === 'asr' ? ' (auto)' : ''}${fromCache ? ' ·cached' : ''}`, D, actions);
      document.getElementById('ytz-panel')._owner = owner;
      if (tr) tr.update(zhSegs);
    } catch (e) { console.error('[yt-zhuyin]', e); showStatus('Failed: ' + e.message, [retryBtn, whisperBtn]); }
  }

  // syncBelow first: leaving /watch must bring YouTube's header back
  window.addEventListener('yt-navigate-finish', () => { syncBelow(); currentVideo = null; init(); });
  init();
})();