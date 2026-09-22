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
    const setUnit = (unit) => { CFG.translateUnit = unit; reset(); push(); update(lastSegs, lastDone); };
    return { reset, update, setUnit };
  }

