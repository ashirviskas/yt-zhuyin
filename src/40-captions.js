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

