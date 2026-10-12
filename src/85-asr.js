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

