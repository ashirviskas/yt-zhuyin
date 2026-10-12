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
  /* every cell as tall as the longest column (˙ + 3 symbols), so word boxes and their underlines line up */
  .ytz-cc{height:calc(${CFG.zhuyinFontSize} * 3.4)}
  #ytz-panel.ytz-top .ytz-cc{height:auto}
  #ytz-panel.ytz-wordgap .ytz-word{border-bottom-color:var(--yt-spec-10-percent-layer,#444)}
  .ytz-cc{display:inline-flex;align-items:center;margin-right:3px}
  .ytz-han{font-size:${CFG.hanFontSize};line-height:1}
  .ytz-zy{display:inline-flex;align-items:flex-end;font-size:${CFG.zhuyinFontSize};line-height:1;margin-left:2px;color:var(--yt-spec-text-secondary,#aaa);white-space:nowrap;font-family:"Noto Sans TC","PingFang TC","BopomofoRuby","Microsoft JhengHei",sans-serif}
  .ytz-col{display:inline-flex;flex-direction:column;align-items:center}
  .ytz-zs{writing-mode:vertical-lr;text-orientation:upright}
  .ytz-dot{width:.32em;height:.32em;border-radius:50%;background:currentColor;margin-bottom:.2em}
  .ytz-tn{font-size:2em;font-weight:700;line-height:.5;width:.45em;margin-left:-.05em}   /* line box = one symbol: sits beside the last one */
  #ytz-panel.ytz-top .ytz-cc{flex-direction:column-reverse;align-items:center;margin-right:6px}
  #ytz-panel.ytz-top .ytz-zy{align-items:center;font-size:${CFG.zhuyinTopFontSize};margin:0 0 2px 0;letter-spacing:.5px}
  #ytz-panel.ytz-top .ytz-zs{writing-mode:horizontal-tb;text-orientation:mixed}
  #ytz-panel.ytz-top .ytz-col{flex-direction:row}
  #ytz-panel.ytz-top .ytz-dot{margin:0 .2em 0 0}
  #ytz-panel.ytz-top .ytz-tn{font-size:1.4em;line-height:.7;width:auto;margin:0 0 0 .05em}
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

  // Textbook layout: the symbols stack in a column with the neutral-tone dot centred above it, and ˊ ˇ ˋ sit
  // in their own slot to the right, level with the last symbol. The dot is drawn, not the ˙ glyph, which
  // renders as an off-centre speck in vertical text.
  function zhuyinParts(z) {
    const dot = z.startsWith('˙'); if (dot) z = z.slice(1);
    const tone = 'ˊˇˋ'.includes(z.at(-1)) ? z.at(-1) : '';
    const col = document.createElement('span'); col.className = 'ytz-col';
    if (dot) { const d = document.createElement('span'); d.className = 'ytz-dot'; col.appendChild(d); }
    const syms = document.createElement('span'); syms.className = 'ytz-zs'; syms.textContent = tone ? z.slice(0, -1) : z;
    col.appendChild(syms);
    if (!tone) return [col];
    const t = document.createElement('span'); t.className = 'ytz-tn'; t.textContent = tone;
    return [col, t];
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
        if (z) { zy.append(...zhuyinParts(normZhuyin(z))); py.push(zhuyinToPinyin(z)); }
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

