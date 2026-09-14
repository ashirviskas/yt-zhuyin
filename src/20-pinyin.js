  // ---- zhuyin normalisation + zhuyin -> pinyin ----
  const Z_INIT = { 'ㄅ':'b','ㄆ':'p','ㄇ':'m','ㄈ':'f','ㄉ':'d','ㄊ':'t','ㄋ':'n','ㄌ':'l','ㄍ':'g','ㄎ':'k','ㄏ':'h','ㄐ':'j','ㄑ':'q','ㄒ':'x','ㄓ':'zh','ㄔ':'ch','ㄕ':'sh','ㄖ':'r','ㄗ':'z','ㄘ':'c','ㄙ':'s' };
  const Z_FIN = { 'ㄚ':'a','ㄛ':'o','ㄜ':'e','ㄝ':'ê','ㄞ':'ai','ㄟ':'ei','ㄠ':'ao','ㄡ':'ou','ㄢ':'an','ㄣ':'en','ㄤ':'ang','ㄥ':'eng','ㄦ':'er',
    'ㄧ':'i','ㄧㄚ':'ia','ㄧㄛ':'io','ㄧㄝ':'ie','ㄧㄞ':'iai','ㄧㄠ':'iao','ㄧㄡ':'iu','ㄧㄢ':'ian','ㄧㄣ':'in','ㄧㄤ':'iang','ㄧㄥ':'ing',
    'ㄨ':'u','ㄨㄚ':'ua','ㄨㄛ':'uo','ㄨㄞ':'uai','ㄨㄟ':'ui','ㄨㄢ':'uan','ㄨㄣ':'un','ㄨㄤ':'uang','ㄨㄥ':'ong',
    'ㄩ':'ü','ㄩㄝ':'üe','ㄩㄢ':'üan','ㄩㄣ':'ün','ㄩㄥ':'iong' };
  const Z_STANDALONE = { 'ㄧ':'yi','ㄧㄚ':'ya','ㄧㄛ':'yo','ㄧㄝ':'ye','ㄧㄞ':'yai','ㄧㄠ':'yao','ㄧㄡ':'you','ㄧㄢ':'yan','ㄧㄣ':'yin','ㄧㄤ':'yang','ㄧㄥ':'ying',
    'ㄨ':'wu','ㄨㄚ':'wa','ㄨㄛ':'wo','ㄨㄞ':'wai','ㄨㄟ':'wei','ㄨㄢ':'wan','ㄨㄣ':'wen','ㄨㄤ':'wang','ㄨㄥ':'weng',
    'ㄩ':'yu','ㄩㄝ':'yue','ㄩㄢ':'yuan','ㄩㄣ':'yun','ㄩㄥ':'yong' };
  const TONE_MARK = { '':'\u0304', 'ˊ':'\u0301', 'ˇ':'\u030c', 'ˋ':'\u0300', '˙':'' };
  // textbook form: neutral ˙ in front, other tones after
  function normZhuyin(s) { return s.endsWith('˙') ? '˙' + s.slice(0, -1) : s; }
  function zhuyinToPinyin(s) {
    let tone = '';
    if (s.startsWith('˙')) { tone = '˙'; s = s.slice(1); }
    else if (s.endsWith('˙')) { tone = '˙'; s = s.slice(0, -1); }
    else if ('ˊˇˋ'.includes(s.at(-1))) { tone = s.at(-1); s = s.slice(0, -1); }
    let init = Z_INIT[s[0]] ? s[0] : '', fin = s.slice(init.length);
    let py;
    if (!init) py = Z_STANDALONE[fin] ?? Z_FIN[fin];
    else { py = Z_INIT[init] + (fin ? (Z_FIN[fin] ?? '?') : 'i'); if ('jqx'.includes(Z_INIT[init])) py = py.replace('ü', 'u'); }
    if (!py) return '?';
    const m = TONE_MARK[tone]; if (!m) return py;
    const vowels = 'aoeêiuü'; let idx = -1;
    for (const v of ['a', 'o', 'e', 'ê']) { idx = py.indexOf(v); if (idx >= 0) break; }
    if (idx < 0) { for (let k = py.length - 1; k >= 0; k--) if (vowels.includes(py[k])) { idx = k; break; } }
    return (py.slice(0, idx + 1) + m + py.slice(idx + 1)).normalize('NFC');
  }

