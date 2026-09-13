import json, re, math
# words: 詞 -> zhuyin string (syllables space-separated)
words = {}
for line in open('mc.txt', encoding='utf-8'):
    p = line.rstrip('\n').split(' ')
    if len(p) < 2: continue
    w, zy = p[0], ' '.join(p[1:])
    if len(w) >= 2 and w not in words:   # keep first (McBopomofo lists preferred first)
        words[w] = zy
occ = {}
for line in open('phrase.occ', encoding='utf-8'):
    p = line.rstrip('\n').split(' ')
    if len(p) == 2 and p[1].isdigit(): occ[p[0]] = int(p[1])
# single chars: all readings, preferred first via heterophony lists
chars = {}
for line in open('BPMFBase.txt', encoding='utf-8'):
    p = line.split(' ')
    if len(p) < 2 or len(p[0]) != 1: continue
    chars.setdefault(p[0], [])
    if p[1] not in chars[p[0]]: chars[p[0]].append(p[1])
for f in ['heterophony3.list', 'heterophony2.list', 'heterophony1.list']:  # 1 applied last => front
    for line in open(f, encoding='utf-8'):
        p = line.split()
        if len(p) == 2 and p[0] in chars and p[1] in chars[p[0]]:
            chars[p[0]].remove(p[1]); chars[p[0]].insert(0, p[1])
# display overrides: McBopomofo heterophony lists are IME-oriented; textbook readings for particles
OVERRIDE = {'嗎':'ㄇㄚ˙','呢':'ㄋㄜ˙','吧':'ㄅㄚ˙','啊':'ㄚ˙','這':'ㄓㄜˋ','那':'ㄋㄚˋ','哪':'ㄋㄚˇ','麼':'ㄇㄜ˙','嘛':'ㄇㄚ˙','喔':'ㄛ˙','欸':'ㄟˋ'}
for c, r in OVERRIDE.items():
    if c in chars:
        if r in chars[c]: chars[c].remove(r)
        chars[c].insert(0, r)
out_total = sum(occ.values())
# compact: "word\tzhuyin\tfreq"
out = {'total': out_total, 'w': {w: [zy, occ.get(w, 0)] for w, zy in words.items()},
       'c': {c: [r, occ.get(c, 0)] for c, r in chars.items()}}
js = 'window.ZHUYIN_DICT=' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';'
open('/mnt/user-data/outputs/zhuyin-dict.js', 'w', encoding='utf-8').write(js)
print(len(words), 'words', len(chars), 'chars', len(js)/1e6, 'MB')
print({k: out['c'][k] for k in '的長和了不得行會'})
