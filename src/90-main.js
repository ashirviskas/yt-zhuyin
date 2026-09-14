  // ---------------------------------------------------------------- main
  let currentVideo = null;
  const forced = {};   // vid -> 'asr' | caption languageCode (user override from the source selector)
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

    // captions can show up in the player response a moment after the video id does
    await waitFor(() => player.getPlayerResponse()?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length, { tries: 12, every: 250 });
    const cap = player.getPlayerResponse().captions?.playerCaptionsTracklistRenderer;
    const tracks = cap?.captionTracks ?? [];
    log('tracks', tracks.map(t => t.languageCode + (t.kind === 'asr' ? '(asr)' : '')));
    const sources = [...tracks.map(t => ({ value: t.languageCode, label: `${trackName(t)}${t.kind === 'asr' ? ' (auto)' : ''}` })), { value: 'asr', label: 'whisper (local)' }];
    const setSource = (v) => { forced[vid] = v; currentVideo = null; init(); };
    const retryBtn = ['retry', () => { currentVideo = null; init(); }];
    const whisperBtn = ['use whisper', () => setSource('asr')];
    if (forced[vid] === 'asr') { if (CFG.asrServer) return asrPath(vid, D, tracks, { sources, source: 'asr', setSource }); showStatus('CFG.asrServer is not set.', [retryBtn]); return; }
    if (!tracks.length) { if (CFG.asrServer) return asrPath(vid, D, tracks, { sources, source: 'asr', setSource }); showStatus('No caption tracks found in the player response.', [retryBtn]); return; }
    const zh = (forced[vid] && tracks.find(t => t.languageCode === forced[vid])) || pickZhTrack(tracks);
    if (!zh) { if (CFG.asrServer) return asrPath(vid, D, tracks, { sources, source: 'asr', setSource }); showStatus('No Chinese track. Available: ' + tracks.map(trackName).join(', '), [retryBtn]); return; }
    const nativeEn = tracks.find(t => /^en/.test(t.languageCode) && t.kind !== 'asr') || tracks.find(t => /^en/.test(t.languageCode));
    const canTranslate = zh.isTranslatable !== false && (cap.translationLanguages ?? []).some(l => l.languageCode === 'en');

    const actions = {
      reload: async () => { await cacheDel(vid); currentVideo = null; init(); },
      clearAll: async () => { await cacheClear(); await mtClear(); currentVideo = null; init(); },
      sources, source: zh.languageCode, setSource,
    };
    try {
      let zhSegs, enT, enN, fromCache = false;
      const hit = await cacheGet(vid);
      if (hit && Date.now() - hit.t < CFG.cacheTtlMs && hit.zhLang === zh.languageCode && hit.enLang === (nativeEn?.languageCode ?? null)) {
        ({ zhSegs, enT, enN } = hit); fromCache = true;
        log('cache hit', vid, Math.round((Date.now() - hit.t) / 1000) + 's old');
      } else {
        const signed = await harvestTimedtextUrl(player, zh.languageCode, nativeEn?.languageCode);
        if (!signed) throw new Error('could not capture a signed timedtext URL from the player');
        [zhSegs, enT, enN] = await Promise.all([
          fetchTrack(signed, zh.languageCode),
          canTranslate ? fetchTrack(signed, zh.languageCode, 'en').catch(e => (log(e), [])) : [],
          nativeEn ? fetchTrack(signed, nativeEn.languageCode).catch(e => (log(e), [])) : [],
        ]);
        if (zhSegs.length) cachePut({ vid, t: Date.now(), zhLang: zh.languageCode, enLang: nativeEn?.languageCode ?? null, zhSegs, enT, enN });
      }
      log('zh', zhSegs.length, 'en-translate', enT.length, 'en-native', enN.length, fromCache ? '(cache)' : '(fetched)');
      if (!zhSegs.length) { showStatus('Chinese track empty.', [retryBtn, whisperBtn]); return; }
      const en = { native: enN.length ? alignByOverlap(zhSegs, enN) : null,
                   translate: enT.length ? alignByOverlap(zhSegs, enT) : null };
      buildPanel(zhSegs, en, `${trackName(zh)}${zh.kind === 'asr' ? ' (auto)' : ''}${fromCache ? ' ·cached' : ''}`, D, actions);
      document.getElementById('ytz-panel')._vid = vid;
      if (!en.native && !en.translate) makeLocalTranslator(vid).update(zhSegs);
    } catch (e) { console.error('[yt-zhuyin]', e); showStatus('Failed: ' + e.message, [retryBtn, whisperBtn]); }
  }

  window.addEventListener('yt-navigate-finish', () => { currentVideo = null; init(); });
  init();
