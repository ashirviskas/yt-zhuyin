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

