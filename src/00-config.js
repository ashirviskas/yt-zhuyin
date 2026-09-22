  const CFG = {
    zhPreference: ['zh-TW', 'zh-Hant', 'zh-HK', 'zh', 'zh-Hans', 'zh-CN'],
    englishDefault: 'native',   // 'native' (human en track, time-overlap aligned) | 'translate' (1:1)
    showPinyin: false,
    showEnglish: true,
    follow: true,
    wordGap: true,              // visible gap between dictionary words
    restoreCaptions: true,      // put player captions back to whatever they were after harvesting
    panelMaxHeight: '60vh',
    zhuyinLayout: 'side',       // 'side' (textbook: vertical column right of the character) | 'top' (horizontal, above)
    hanFontSize: '30px',
    zhuyinFontSize: '14px',     // side layout: ~half the character height is the readable minimum on a 96-dpi screen
    zhuyinTopFontSize: '13px',
    cacheTtlMs: 60 * 60 * 1000, // transcript cache TTL
    cacheMax: 50,               // max cached videos (oldest evicted)
    harvestAttempts: 3,         // caption-load triggers before giving up
    harvestTimeoutMs: 3000,     // per attempt
    waitForPlaybackMs: 15000,   // wait for the player to start before harvesting (captions load lazily)
    asrServer: 'http://127.0.0.1:8765', // local asr_server.py; set null to disable
    asrPollMs: 4000,
    localTranslate: true,       // ask the local server for a per-line English translation when YouTube has none
    translateBatch: 24,         // sentences per /translate request; smaller = English shows up sooner on long videos
    translateUnit: 'sentence',  // 'sentence': group lines into sentences before translating (English shown on the first line) | 'line'
    sentenceMaxChars: 60,       // sentence grouping: force a break after this many Chinese cells (a latin letter counts 1/3)
    sentenceGapSec: 1.5,        // sentence grouping: a pause longer than this ends a sentence
    mtCacheMax: 20000,          // translated lines kept in IndexedDB (oldest evicted)         // lines per /translate request; smaller = English shows up sooner on long videos
    asrMaxChars: 14,            // re-chunk whisper word timestamps into lines of at most this many Chinese cells (a latin letter counts 1/3)
    asrMinChars: 4,             // don't cut on a pause before this many Chinese cells
    asrGapSec: 0.7,             // a silence longer than this ends a line            // how often to poll the server while it transcribes
    pollMs: 100,                // highlight update interval; one getCurrentTime() call per tick
    debug: true,
  };

