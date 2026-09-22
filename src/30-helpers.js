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
