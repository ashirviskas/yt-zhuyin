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
