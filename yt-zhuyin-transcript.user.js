// ==UserScript==
// @name         YouTube 注音 transcript (zh-TW + zhuyin, pinyin optional, English)
// @namespace    local.yt-zhuyin
// @version      0.2.1
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
    hanFontSize: '22px',
    zhuyinFontSize: '10px',
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

  // Get a signed timedtext URL (with pot) by making the player fetch a track itself.
  function harvestTimedtextUrl(player, langCode) {
    return new Promise((resolve) => {
      const seen = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/timedtext'));
      let done = false;
      const finish = (u) => { if (done) return; done = true; obs.disconnect(); resolve(u); };
      const obs = new PerformanceObserver((list) => {
        const hit = list.getEntries().find(e => e.name.includes('/api/timedtext') && e.name.includes('pot='));
        if (hit) finish(hit.name);
      });
      obs.observe({ type: 'resource', buffered: false });
      const prev = player.getOption?.('captions', 'track');
      player.loadModule?.('captions');
      player.setOption('captions', 'track', { languageCode: langCode });
      setTimeout(() => {
        if (done) return;
        // maybe it was already cached from before we observed
        const late = performance.getEntriesByType('resource').map(e => e.name).filter(u => u.includes('/api/timedtext') && u.includes('pot='));
        finish(late.at(-1) ?? seen.at(-1)?.name ?? null);
      }, 4000);
      if (CFG.restoreCaptions) setTimeout(() => {
        if (prev && prev.languageCode) player.setOption('captions', 'track', prev);
        else player.setOption('captions', 'track', {});
      }, 1500);
    });
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

  // ---------------------------------------------------------------- render
  const CSS = `
  #ytz-panel{margin:0 0 12px;border:1px solid var(--yt-spec-10-percent-layer,#333);border-radius:12px;background:var(--yt-spec-base-background,#0f0f0f);color:var(--yt-spec-text-primary,#f1f1f1);font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",Roboto,sans-serif;overflow:hidden}
  #ytz-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--yt-spec-10-percent-layer,#333);font-size:13px}
  #ytz-head .ytz-title{font-weight:500;margin-right:auto}
  #ytz-head label{display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none}
  #ytz-head select{background:transparent;color:inherit;border:1px solid var(--yt-spec-10-percent-layer,#333);border-radius:4px}
  #ytz-status{padding:10px 12px;font-size:13px;color:var(--yt-spec-text-secondary,#aaa)}
  #ytz-body{max-height:${CFG.panelMaxHeight};overflow-y:auto}
  .ytz-row{display:grid;grid-template-columns:52px 1fr;gap:8px;padding:8px 12px;cursor:pointer;border-left:3px solid transparent}
  .ytz-row:hover{background:var(--yt-spec-badge-chip-background,#272727)}
  .ytz-row.ytz-active{border-left-color:#ff0033;background:var(--yt-spec-badge-chip-background,#272727)}
  .ytz-ts{font-size:12px;color:var(--yt-spec-text-secondary,#aaa);padding-top:6px;font-variant-numeric:tabular-nums}
  .ytz-zh{line-height:1.15}
  .ytz-word{display:inline-flex;align-items:center;margin:0 ${CFG.wordGap ? 7 : 2}px 4px 0;vertical-align:middle;border-bottom:1px dotted transparent}
  #ytz-panel.ytz-wordgap .ytz-word{border-bottom-color:var(--yt-spec-10-percent-layer,#444)}
  .ytz-cc{display:inline-flex;align-items:center;margin-right:2px}
  .ytz-han{font-size:${CFG.hanFontSize};line-height:1}
  .ytz-zy{writing-mode:vertical-lr;text-orientation:upright;font-size:${CFG.zhuyinFontSize};line-height:1;margin-left:1px;letter-spacing:-1px;color:var(--yt-spec-text-secondary,#aaa);white-space:nowrap}
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

  function buildPanel(segs, en, meta, D) {
    injectCss();
    document.getElementById('ytz-panel')?._cleanup?.();
    document.getElementById('ytz-panel')?.remove();
    const panel = document.createElement('div'); panel.id = 'ytz-panel';
    panel.classList.toggle('ytz-nopy', !CFG.showPinyin);
    panel.classList.toggle('ytz-noen', !CFG.showEnglish);
    panel.classList.toggle('ytz-wordgap', CFG.wordGap);

    const enModes = Object.keys(en).filter(k => en[k]?.length);
    const enMode0 = enModes.includes(CFG.englishDefault) ? CFG.englishDefault : enModes[0];
    const head = document.createElement('div'); head.id = 'ytz-head';
    head.innerHTML = `<span class="ytz-title">${meta}</span>
      <label><input type="checkbox" id="ytz-py" ${CFG.showPinyin ? 'checked' : ''}>pinyin</label>
      <label><input type="checkbox" id="ytz-en" ${CFG.showEnglish ? 'checked' : ''}>English</label>
      <select id="ytz-enmode">${enModes.map(m => `<option value="${m}" ${m === enMode0 ? 'selected' : ''}>${m === 'native' ? 'native EN' : 'auto-translated'}</option>`).join('')}</select>
      <label><input type="checkbox" id="ytz-follow" ${CFG.follow ? 'checked' : ''}>follow</label>`;
    panel.appendChild(head);

    const body = document.createElement('div'); body.id = 'ytz-body';
    const rows = [], enEls = [];
    for (const s of segs) {
      const row = document.createElement('div'); row.className = 'ytz-row';
      const ts = document.createElement('div'); ts.className = 'ytz-ts'; ts.textContent = fmtTime(s.start);
      const col = document.createElement('div');
      const { wrap, py } = renderZh(s.text, D);
      const pyEl = document.createElement('div'); pyEl.className = 'ytz-py'; pyEl.textContent = py;
      const enEl = document.createElement('div'); enEl.className = 'ytz-en';
      col.append(wrap, pyEl, enEl); row.append(ts, col);
      row.addEventListener('click', () => document.getElementById('movie_player')?.seekTo(s.start, true));
      body.appendChild(row); rows.push(row); enEls.push(enEl);
    }
    panel.appendChild(body);
    const applyEn = (mode) => { const lines = en[mode] ?? []; enEls.forEach((el, i) => el.textContent = lines[i] ?? ''); };
    applyEn(enMode0);

    head.querySelector('#ytz-py').onchange = e => panel.classList.toggle('ytz-nopy', !e.target.checked);
    head.querySelector('#ytz-en').onchange = e => panel.classList.toggle('ytz-noen', !e.target.checked);
    head.querySelector('#ytz-follow').onchange = e => { CFG.follow = e.target.checked; };
    head.querySelector('#ytz-enmode').onchange = e => applyEn(e.target.value);

    (document.querySelector('#secondary-inner') || document.querySelector('#secondary')).prepend(panel);

    const video = document.querySelector('video.html5-main-video');
    let active = -1;
    const onTime = () => {
      const t = video.currentTime; let idx = -1;
      for (let i = 0; i < segs.length; i++) { if (segs[i].start <= t) idx = i; else break; }
      if (idx === active) return;
      rows[active]?.classList.remove('ytz-active'); active = idx;
      if (idx >= 0) { rows[idx].classList.add('ytz-active'); if (CFG.follow) rows[idx].scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    };
    video.addEventListener('timeupdate', onTime);
    panel._cleanup = () => video.removeEventListener('timeupdate', onTime);
  }

  function showStatus(msg) {
    injectCss();
    let panel = document.getElementById('ytz-panel');
    if (!panel) { panel = document.createElement('div'); panel.id = 'ytz-panel';
      (document.querySelector('#secondary-inner') || document.querySelector('#secondary'))?.prepend(panel); }
    panel.innerHTML = `<div id="ytz-status">${msg}</div>`;
  }

  // ---------------------------------------------------------------- main
  let currentVideo = null;
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

    const cap = player.getPlayerResponse().captions?.playerCaptionsTracklistRenderer;
    const tracks = cap?.captionTracks ?? [];
    log('tracks', tracks.map(t => t.languageCode + (t.kind === 'asr' ? '(asr)' : '')));
    if (!tracks.length) { showStatus('No caption tracks.'); return; }
    const zh = pickZhTrack(tracks);
    if (!zh) { showStatus('No Chinese track. Available: ' + tracks.map(trackName).join(', ')); return; }
    const nativeEn = tracks.find(t => /^en/.test(t.languageCode) && t.kind !== 'asr') || tracks.find(t => /^en/.test(t.languageCode));
    const canTranslate = zh.isTranslatable !== false && (cap.translationLanguages ?? []).some(l => l.languageCode === 'en');

    try {
      const signed = await harvestTimedtextUrl(player, zh.languageCode);
      if (!signed) throw new Error('could not capture a signed timedtext URL from the player');
      const [zhSegs, enT, enN] = await Promise.all([
        fetchTrack(signed, zh.languageCode),
        canTranslate ? fetchTrack(signed, zh.languageCode, 'en').catch(e => (log(e), [])) : [],
        nativeEn ? fetchTrack(signed, nativeEn.languageCode).catch(e => (log(e), [])) : [],
      ]);
      log('zh', zhSegs.length, 'en-translate', enT.length, 'en-native', enN.length);
      if (!zhSegs.length) { showStatus('Chinese track empty.'); return; }
      const en = { native: enN.length ? alignByOverlap(zhSegs, enN) : null,
                   translate: enT.length ? alignByOverlap(zhSegs, enT) : null };
      buildPanel(zhSegs, en, `${trackName(zh)}${zh.kind === 'asr' ? ' (auto)' : ''}`, D);
    } catch (e) { console.error('[yt-zhuyin]', e); showStatus('Failed: ' + e.message); }
  }

  window.addEventListener('yt-navigate-finish', () => { currentVideo = null; init(); });
  init();
})();
