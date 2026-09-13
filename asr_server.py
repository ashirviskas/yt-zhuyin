#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "faster-whisper>=1.1",
#   "opencc-python-reimplemented",
#   "yt-dlp",
#   "torch",
#   "transformers>=4.40",
#   "sentencepiece",
#   "sacremoses",
# ]
#
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
#
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }
# ///
"""
Local ASR service for yt-zhuyin. One file, no framework.

    uv run asr_server.py                 # uv resolves the deps above into a cached env on first run
    uv run asr_server.py --model medium  # better Mandarin, ~1.5 GB RAM, ~2-3x slower
    (without uv: pip install faster-whisper opencc-python-reimplemented yt-dlp && python3 asr_server.py)

Endpoints (CORS open, only bound to 127.0.0.1):
    GET /transcript/<videoId>   -> {"status": "queued"|"downloading"|"transcribing"|"ready"|"error",
                                    "segs": [{"start","end","text"}...], "done": bool, "error": str}
    POST /translate {"lines": [...zh...]}  -> {"lines": [...en...]}   (opus-mt-zh-en on CPU, cached by text)
    GET /status                 -> queue + model info
    DELETE /transcript/<videoId>-> drop cache entry

First GET for a video starts the job; subsequent GETs return progress (segments so far) and act as a
heartbeat. If no GET arrives for --lease-sec (default 60) the job is paused after its current segment and
its partial result kept; the next GET resumes from where it stopped. Queued jobs nobody is polling for
are skipped the same way, so closing the tab stops the CPU burn within a minute.
Results are cached in ~/.cache/yt-zhuyin/<videoId>.json; downloaded audio in ~/.cache/yt-zhuyin/audio/ (LRU, --audio-cache-gb).
"""
import argparse, json, os, re, subprocess, sys, threading, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "yt-zhuyin"
AUDIO = CACHE / "audio"
CACHE.mkdir(parents=True, exist_ok=True)
AUDIO.mkdir(exist_ok=True)
AUDIO_MAX_BYTES = 2 * 1024 ** 3   # overridden by --audio-cache-gb
LEASE_SEC = 60                    # overridden by --lease-sec
VID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

jobs = {}            # vid -> dict(status, segs, done, error, t)
jobs_lock = threading.Lock()
queue = []           # vids waiting
queue_cv = threading.Condition()
model = None
cc = None
cc_t2s = None
mt = None            # (tokenizer, model) lazily loaded
mt_lock = threading.Lock()
mt_cache = {}        # zh line -> en
MT_NAME = "Helsinki-NLP/opus-mt-zh-en"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def load_model(name):
    global model, cc
    from faster_whisper import WhisperModel
    log(f"loading faster-whisper '{name}' (int8, cpu)…")
    model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
    try:
        from opencc import OpenCC
        cc = OpenCC("s2twp")            # simplified -> Taiwan traditional incl. TW phrasing
        cc_t2s = OpenCC("t2s")          # for the MT model, which was trained mostly on simplified text
    except Exception as e:
        log("opencc unavailable, output may contain simplified characters:", e)
    log("model ready")


def load_mt():
    """Marian zh->en, ~300 MB weights, loaded on first /translate call. torch CPU only."""
    global mt
    with mt_lock:
        if mt is not None or MT_NAME is None:
            return mt
        import torch
        import transformers
        from transformers import MarianMTModel, MarianTokenizer
        transformers.utils.logging.set_verbosity_error()      # silence per-call generation warnings
        torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))
        log(f"loading MT '{MT_NAME}'…")
        tok = MarianTokenizer.from_pretrained(MT_NAME)
        mdl = MarianMTModel.from_pretrained(MT_NAME).eval()
        mt = (tok, mdl)
        log("MT ready")
        return mt


def translate_lines(lines):
    m = load_mt()
    if m is None:
        return [None] * len(lines)
    tok, mdl = m
    import torch
    out = [mt_cache.get(l) for l in lines]
    todo = [i for i, l in enumerate(lines) if out[i] is None and l.strip()]
    for b in range(0, len(todo), 16):
        idx = todo[b:b + 16]
        src = [cc_t2s.convert(lines[i]) if cc_t2s else lines[i] for i in idx]
        with torch.inference_mode():
            enc = tok(src, return_tensors="pt", padding=True, truncation=True, max_length=128)
            gen = mdl.generate(**enc, num_beams=2, max_length=160)   # max_length only: avoids the max_new_tokens/max_length warning
        for i, t in zip(idx, tok.batch_decode(gen, skip_special_tokens=True)):
            out[i] = mt_cache[lines[i]] = t.strip()
    if len(mt_cache) > 20000:
        mt_cache.clear()
    return [o or "" for o in out]


def download_audio(vid):
    """Return path to cached audio, downloading if needed. ~1 MB/min at bestaudio."""
    out = AUDIO / f"{vid}.m4a"
    if out.exists() and out.stat().st_size > 0:
        out.touch()                                   # bump mtime for LRU
        log(f"{vid}: audio from cache")
        return out
    # run yt-dlp from the same interpreter so it works inside uv's env without PATH games
    cmd = [sys.executable, "-m", "yt_dlp", "-f", "bestaudio[ext=m4a]/bestaudio", "--no-playlist",
           "-o", str(AUDIO / f"{vid}.%(ext)s"), f"https://www.youtube.com/watch?v={vid}"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("yt-dlp failed: " + (r.stderr.strip().splitlines()[-1] if r.stderr else "unknown"))
    found = sorted(AUDIO.glob(f"{vid}.*"), key=lambda p: p.stat().st_size, reverse=True)
    if not found:
        raise RuntimeError("yt-dlp produced no file")
    if found[0] != out:
        found[0].rename(out)                          # normalise extension; whisper/ffmpeg don't care
    evict_audio()
    return out


def audio_cache_bytes():
    return sum(p.stat().st_size for p in AUDIO.iterdir() if p.is_file())


def evict_audio():
    files = sorted((p for p in AUDIO.iterdir() if p.is_file()), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    while files and total > AUDIO_MAX_BYTES:
        p = files.pop(0)
        total -= p.stat().st_size
        log(f"audio cache: evicting {p.name}")
        p.unlink(missing_ok=True)


def lease_expired(vid):
    with jobs_lock:
        return time.time() - jobs[vid].get("last_seen", 0) > LEASE_SEC


def save_partial(vid):
    with jobs_lock:
        j = jobs[vid]
        data = {"vid": vid, "segs": j["segs"], "words": j["words"], "resume_from": j.get("resume_from", 0.0), "t": time.time()}
    (CACHE / f"{vid}.partial.json").write_text(json.dumps(data, ensure_ascii=False))


def transcribe(vid, path, translate):
    """Transcribe from jobs[vid]['resume_from']; returns (segs, words, en, finished)."""
    with jobs_lock:
        resume_from = float(jobs[vid].get("resume_from", 0.0))
        segs = list(jobs[vid]["segs"])
        words = list(jobs[vid]["words"])
    seg_iter, info = model.transcribe(
        str(path), language="zh", task="transcribe",
        beam_size=1, vad_filter=True, condition_on_previous_text=False,
        word_timestamps=True,                    # lets the client re-chunk into shorter lines
        clip_timestamps=f"{resume_from:.2f}" if resume_from > 0 else "0",
        # a punctuated traditional-Chinese prompt nudges whisper to emit both traditional characters AND punctuation
        initial_prompt="以下是臺灣的繁體中文字幕，有標點符號。大家好，今天我們來聊聊這個話題。",
    )
    log(f"{vid}: audio {info.duration:.0f}s" + (f", resuming at {resume_from:.0f}s" if resume_from else ""))
    finished = True
    for s in seg_iter:
        text = s.text.strip()
        if text:
            if cc:
                text = cc.convert(text)
            segs.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": text})
            for w in (s.words or []):
                wt = w.word.strip()
                if not wt:
                    continue
                words.append({"start": round(w.start, 3), "end": round(w.end, 3), "text": cc.convert(wt) if cc else wt})
        with jobs_lock:
            jobs[vid]["segs"] = list(segs)
            jobs[vid]["words"] = list(words)
            jobs[vid]["resume_from"] = float(s.end)
            jobs[vid]["progress"] = round(s.end / info.duration, 3) if info.duration else 0
        if lease_expired(vid):
            log(f"{vid}: nobody watching for {LEASE_SEC}s, pausing at {s.end:.0f}s")
            finished = False
            break
    en = None
    if finished and translate:
        with jobs_lock:
            jobs[vid]["status"] = "translating"
        seg_iter, _ = model.transcribe(str(path), language="zh", task="translate", beam_size=1, vad_filter=True)
        en = [{"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()} for s in seg_iter if s.text.strip()]
    return segs, words, en, finished


def worker(translate):
    while True:
        with queue_cv:
            while not queue:
                queue_cv.wait()
            vid = queue.pop(0)
        if lease_expired(vid):                       # queued but the tab is gone: don't waste CPU on it
            with jobs_lock:
                jobs[vid]["status"] = "paused"
            log(f"{vid}: skipped (no heartbeat)")
            continue
        try:
            with jobs_lock:
                jobs[vid]["status"] = "downloading"
            audio = download_audio(vid)
            with jobs_lock:
                jobs[vid]["status"] = "transcribing"
            t0 = time.time()
            segs, words, en, finished = transcribe(vid, audio, translate)
            if not finished:
                with jobs_lock:
                    jobs[vid]["status"] = "paused"
                save_partial(vid)
                continue
            result = {"vid": vid, "segs": segs, "words": words, "en": en, "model": MODEL_NAME, "t": time.time()}
            (CACHE / f"{vid}.json").write_text(json.dumps(result, ensure_ascii=False))
            (CACHE / f"{vid}.partial.json").unlink(missing_ok=True)
            with jobs_lock:
                jobs[vid].update(status="ready", segs=segs, words=words, en=en, done=True, progress=1.0)
            log(f"{vid}: done, {len(segs)} segments in {time.time() - t0:.0f}s")
        except Exception as e:
            traceback.print_exc()
            with jobs_lock:
                jobs[vid].update(status="error", error=str(e), done=True)


def get_or_start(vid):
    cached = CACHE / f"{vid}.json"
    if cached.exists():
        d = json.loads(cached.read_text())
        return {"status": "ready", "segs": d["segs"], "words": d.get("words"), "en": d.get("en"), "done": True, "progress": 1.0, "cached": True}
    now = time.time()
    with jobs_lock:
        j = jobs.get(vid)
        if j is None:
            j = jobs[vid] = {"status": "queued", "segs": [], "words": [], "en": None, "done": False,
                             "progress": 0.0, "resume_from": 0.0, "t": now, "last_seen": now}
            partial = CACHE / f"{vid}.partial.json"
            if partial.exists():                     # survive a server restart mid-video
                try:
                    d = json.loads(partial.read_text())
                    j.update(segs=d["segs"], words=d["words"], resume_from=d.get("resume_from", 0.0))
                    log(f"{vid}: loaded partial result, resume at {j['resume_from']:.0f}s")
                except Exception as e:
                    log("bad partial file:", e)
            enqueue = True
        else:
            j["last_seen"] = now                     # heartbeat
            enqueue = j["status"] == "paused"
            if enqueue:
                j["status"] = "queued"
        if enqueue:
            with queue_cv:
                if vid not in queue:
                    queue.append(vid)
                queue_cv.notify()
        return {k: v for k, v in j.items() if k != "last_seen"}


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_POST(self):
        if self.path != "/translate":
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            lines = json.loads(self.rfile.read(n) or b"{}").get("lines", [])
            if not isinstance(lines, list) or len(lines) > 2000:
                return self._send(400, {"error": "lines must be a list (max 2000)"})
            t0 = time.time()
            res = translate_lines([str(l) for l in lines])
            log(f"translated {len(lines)} lines in {time.time() - t0:.1f}s")
            return self._send(200, {"lines": res})
        except Exception as e:
            traceback.print_exc()
            return self._send(500, {"error": str(e)})

    def do_GET(self):
        if self.path == "/status":
            with jobs_lock:
                return self._send(200, {"model": MODEL_NAME, "mt": MT_NAME, "mt_loaded": mt is not None, "queue": list(queue),
                                        "jobs": {k: v["status"] for k, v in jobs.items()},
                                        "audio_cache_mb": round(audio_cache_bytes() / 1e6, 1),
                                        "audio_cache_limit_mb": round(AUDIO_MAX_BYTES / 1e6)})
        m = re.match(r"^/transcript/([^/?]+)", self.path)
        if not m or not VID_RE.match(m.group(1)):
            return self._send(404, {"error": "not found"})
        return self._send(200, get_or_start(m.group(1)))

    def do_DELETE(self):
        m = re.match(r"^/transcript/([^/?]+)", self.path)
        if not m or not VID_RE.match(m.group(1)):
            return self._send(404, {"error": "not found"})
        vid = m.group(1)
        (CACHE / f"{vid}.json").unlink(missing_ok=True)
        (CACHE / f"{vid}.partial.json").unlink(missing_ok=True)
        if "audio=1" in self.path:                     # DELETE /transcript/<id>?audio=1 also drops the audio
            (AUDIO / f"{vid}.m4a").unlink(missing_ok=True)
        with jobs_lock:
            jobs.pop(vid, None)
        return self._send(200, {"deleted": vid})

    def log_message(self, fmt, *args):   # quieter default logging
        if "/status" not in (args[0] if args else ""):
            log(self.address_string(), fmt % args)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="small", help="faster-whisper model: tiny/base/small/medium/large-v3 or a HF repo id")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--translate", action="store_true", help="also produce whisper's own English pass (doubles CPU time; usually worse than /translate)")
    ap.add_argument("--mt", default=MT_NAME, help="HF Marian model for /translate, or 'none' to disable")
    ap.add_argument("--audio-cache-gb", type=float, default=2.0, help="keep downloaded audio up to this size (LRU), 0 = don't keep")
    ap.add_argument("--lease-sec", type=int, default=60, help="pause a job if no client polled it for this long")
    args = ap.parse_args()
    AUDIO_MAX_BYTES = int(args.audio_cache_gb * 1024 ** 3)
    LEASE_SEC = args.lease_sec
    MODEL_NAME = args.model
    MT_NAME = None if args.mt.lower() == 'none' else args.mt
    load_model(args.model)
    threading.Thread(target=worker, args=(args.translate,), daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), H)
    log(f"listening on http://127.0.0.1:{args.port}  cache: {CACHE}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
