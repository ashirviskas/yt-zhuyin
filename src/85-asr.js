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

