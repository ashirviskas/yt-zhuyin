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
  .ytz-row.ytz-grp{border-left-color:rgba(232,179,57,.35)}
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
    const unitSel = document.createElement('select'); unitSel.id = 'ytz-enunit';
    unitSel.title = 'local MT: whole sentences read better, line by line lines up with the Chinese';
    for (const [v, l] of [['sentence', 'by sentence'], ['line', 'line by line']]) {
      const o = document.createElement('option'); o.value = v; o.textContent = l; o.selected = v === CFG.translateUnit; unitSel.appendChild(o); }
    head.append(mkToggle('ytz-top', 'zhuyin on top', CFG.zhuyinLayout === 'top'), mkToggle('ytz-py', 'pinyin', CFG.showPinyin), mkToggle('ytz-en', 'English', CFG.showEnglish), enSel,
      ...(actions.retranslate ? [unitSel] : []), mkToggle('ytz-follow', 'follow', CFG.follow),
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
    if (actions.retranslate) head.querySelector('#ytz-enunit').onchange = e => actions.retranslate(e.target.value);

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

