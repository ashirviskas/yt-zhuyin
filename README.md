# yt-zhuyin

A Firefox userscript that adds a side panel to YouTube watch pages showing the video's traditional Chinese captions with 注音 (zhuyin / bopomofo) next to every character, plus an aligned English line. Built for learning Taiwanese Mandarin from real videos.

![panel screenshot](screenshot.png)

## What it does

- Reads the video's Chinese caption track (prefers `zh-TW`, then `zh-Hant`, `zh-HK`, `zh`) and shows it in a scrollable panel above the recommendations column.
- Splits each line into words using a Taiwan Mandarin dictionary and prints zhuyin for every character. Readings come from the dictionary, not from pinyin — 垃圾 is ㄌㄜˋ ㄙㄜˋ, 星期 is ㄒㄧㄥ ㄑㄧˊ, 會計 is ㄎㄨㄞˋ ㄐㄧˋ.
- Zhuyin sits in a vertical column to the right of each character, the way Taiwanese books set it. A toggle moves it above the characters if that's easier while you're learning the symbols.
- Optional pinyin line, derived from the zhuyin.
- English line under each segment: the channel's own English track if there is one, otherwise YouTube's auto-translation. A dropdown switches between the two.
- Click a line to seek. The current line is highlighted and the panel follows playback.
- Characters shown in amber are polyphonic and were read on their own, without a dictionary word to settle the reading. Hover to see the alternatives.

Everything runs in the browser. No accounts, no external services; the only network requests are to YouTube's own caption endpoint and to the CDN that serves the dictionary file.

## Install

1. Install a userscript manager. [Violentmonkey](https://violentmonkey.github.io/) is open source (MIT) and the one this was tested with. [Tampermonkey](https://www.tampermonkey.net/) works too but is closed source. Greasemonkey 4 is not recommended — its `@require` handling is unreliable.
2. Open the raw script URL and the manager will offer to install it:

   https://raw.githubusercontent.com/ashirviskas/yt-zhuyin/main/yt-zhuyin-transcript.user.js

   Install from that URL rather than pasting the source, so the manager can pick up updates.
3. Open any YouTube video with Chinese captions. The panel appears within a few seconds. Captions may flash on briefly while the script sets things up; that's expected.

The dictionary (`zhuyin-dict.js`, about 6 MB) is pulled once by the userscript manager through jsDelivr and cached.

### Fonts

Zhuyin glyphs and tone marks look best with a CJK font that includes bopomofo. On Arch: `sudo pacman -S noto-fonts-cjk`. On Fedora: `sudo dnf install google-noto-sans-cjk-fonts`. Without one, Firefox falls back to whatever font has the code points and the tone marks come out uneven.

## Settings

Open the script in your userscript manager and edit the `CFG` block at the top. The ones you're most likely to touch:

| Key | Default | Meaning |
|---|---|---|
| `zhuyinLayout` | `'side'` | `'side'` for the vertical column, `'top'` for horizontal above the character |
| `hanFontSize` / `zhuyinFontSize` | `30px` / `14px` | sizes in the side layout |
| `showPinyin` | `false` | pinyin line on by default |
| `englishDefault` | `'native'` | `'native'` prefers the channel's English track, `'translate'` prefers auto-translation (which lines up 1:1 with the Chinese) |
| `restoreCaptions` | `true` | put player captions back to their previous state after setup; set `false` to leave zh-TW subtitles on and avoid the flash |
| `wordGap` | `true` | dotted underline and spacing between dictionary words |

The header toggles (pinyin, English, zhuyin on top, follow) change the current panel only; edit `CFG` to change defaults.

## How it works

YouTube's caption endpoint needs a per-session token that the player attaches to its own requests. The script asks the player to load a caption track, watches the Performance API for that request, and reuses the signed URL with different `lang`/`tlang` parameters. Nothing is patched or intercepted.

Each caption line is segmented with a unigram maximum-likelihood search over the dictionary (Viterbi over word frequencies), so longer known words win over character-by-character readings. Pinyin is generated from the zhuyin through a fixed table, so the two can never disagree.

## Rebuilding the dictionary

`build_zhuyin_dict.py` reads McBopomofo's data files and writes `zhuyin-dict.js`. To rebuild:

```sh
for f in BPMFMappings.txt BPMFBase.txt phrase.occ heterophony1.list heterophony2.list heterophony3.list; do
  curl -sLO https://raw.githubusercontent.com/openvanilla/McBopomofo/master/Source/Data/$f
done
mv BPMFMappings.txt mc.txt
python3 build_zhuyin_dict.py
```

There's a small `OVERRIDE` table near the top of the script for characters whose IME-preferred reading isn't the textbook one (particles like 嗎, 呢, 吧 read with a neutral tone). Add to it in zhuyin.

After pushing a new `zhuyin-dict.js`, bump `@version` in the userscript so managers refetch the `@require`, and purge the jsDelivr cache or wait up to 12 hours:

    https://purge.jsdelivr.net/gh/ashirviskas/yt-zhuyin@main/zhuyin-dict.js

## Known limitations

- Segment boundaries are the caption author's. A word split across two caption lines is read as two separate characters.
- Auto-generated (ASR) Chinese tracks arrive as short fragments and segment poorly.
- Citation tones only; tone sandhi (一, 不, third-tone pairs) is not shown.
- Panel placement depends on YouTube's `#secondary` layout. When YouTube changes its markup the panel may end up in the wrong place or not appear.

## License

MIT. See `LICENSE`.

`zhuyin-dict.js` is derived from [McBopomofo](https://github.com/openvanilla/McBopomofo)'s dictionary data (MIT, © Mengjuei Hsieh et al.), which in turn descends from libtabe's `tsi.src` (BSD).
