#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.13"
# dependencies = [
#   "faster-whisper>=1.1",
#   "opencc-python-reimplemented",
#   "yt-dlp",
#   "torch",
#   "transformers>=4.40",
#   "sentencepiece",
#   "sacremoses",
#   "fastapi",
#   "uvicorn",
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
Local ASR service for yt-zhuyin.

    uv run asr_server.py                 # uv resolves the deps above into a cached env on first run
    uv run asr_server.py --model medium  # better Mandarin, ~1.5 GB RAM, ~2-3x slower

Endpoints (CORS open, only bound to 127.0.0.1):
    GET /transcript/<videoId>   -> {"status": "queued"|"downloading"|"transcribing"|"ready"|"error",
                                    "segs": [{"start","end","text"}...], "done": bool, "error": str}
    POST /translate {"lines": [...zh...]}  -> {"lines": [...en...]}   (opus-mt-zh-en on CPU, cached by text)
    GET /status[?pretty=1]      -> every job with its progress, speed and ETA, plus memory,
                                   queue, model state and cache sizes
    GET /                       -> htmx dashboard: live stats, progress bars, memory and
                                   activity charts, transcript and audio preview per job
    GET /history[?limit=N]      -> the samples behind those charts
    DELETE /transcript/<videoId>[?audio=1]  -> drop the cache entry (and its audio)
    POST /job/<videoId>/start[?force=1]     -> start or resume; force: keep going without a polling tab
    POST /job/<videoId>/stop                -> pause after the current segment, keep the partial
    POST /jobs  video=<id or URL>           -> the dashboard's add box (forced)
    POST /settings                          -> the dashboard's settings form, saved to settings.json

First GET for a video starts the job; subsequent GETs return progress (segments so far) and act as a
heartbeat. If no GET arrives for --lease-sec (default 60) the job is paused after its current segment and
its partial result kept; the next GET resumes from where it stopped. Running jobs also checkpoint every 30 s,
on error and on shutdown. A stopped or failed job waits for an explicit /start. Queued jobs nobody is polling for
are skipped the same way, so closing the tab stops the CPU burn within a minute.
Results are cached in ~/.cache/yt-zhuyin/<videoId>.json; downloaded audio in ~/.cache/yt-zhuyin/audio/ (LRU, --audio-cache-gb).

Code lives in ytz_asr/: jobs.py (state), asr.py (audio + whisper), translate.py (zh->en),
server.py (FastAPI routes), dashboard.py (the HTML), titles.py (video titles for the dashboard).
"""

import argparse
import threading
import time

from ytz_asr import SETTINGS, Config, log
from ytz_asr import asr, server, titles, translate
from ytz_asr.jobs import JobStore

FLUSH_EVERY_SEC = 30
JANITOR_EVERY_SEC = 15


def parse_args() -> Config:
    """Flags left out keep the value saved from the dashboard (settings.json), then the default."""
    p = argparse.ArgumentParser(description="Local Whisper ASR + translation service for yt-zhuyin.")
    _ = p.add_argument("--model",
                       help="faster-whisper model: tiny/base/small/medium/large-v3 or a HF repo id (default small)")
    _ = p.add_argument("--port", type=int, default=8765)
    _ = p.add_argument("--workers", type=int,
                       help="videos transcribed at once; CPU cores are split between them (default 2)")
    _ = p.add_argument("--translate", dest="whisper_translate", action="store_const", const=True,
                       help="also produce whisper's own English pass (doubles CPU time; usually worse than /translate)")
    _ = p.add_argument("--mt", default="Helsinki-NLP/opus-mt-zh-en",
                       help="HF Marian model for /translate, or 'none' to disable")
    _ = p.add_argument("--no-live-translate", dest="live_translate", action="store_const", const=False,
                       help="only translate on request, instead of alongside transcription")
    _ = p.add_argument("--audio-cache-gb", type=float,
                       help="keep downloaded audio up to this size (LRU), 0 = don't keep (default 2)")
    _ = p.add_argument("--lease-sec", type=int,
                       help="pause a job if no client polled it for this long (default 60)")
    _ = p.add_argument("--idle-unload-sec", type=int,
                       help="drop model weights after this many idle seconds, 0 = keep loaded (default 61)")
    a = vars(p.parse_args())
    given = {k: a[k] for k in SETTINGS if a.get(k) is not None}
    if "workers" in given:
        given["workers"] = max(1, int(given["workers"]))
    cfg = Config(
        port=int(a["port"]),
        mt=None if str(a["mt"]).lower() == "none" else str(a["mt"]),
        flags=frozenset(given),
        **given,
    )
    cfg.load_settings()
    return cfg


def flush_periodically(cfg: Config) -> None:
    while True:
        time.sleep(FLUSH_EVERY_SEC)
        translate.cache_flush(cfg)


def janitor(cfg: Config) -> None:
    """Give the weights back to the OS once nothing has used them for a while."""
    while True:
        time.sleep(JANITOR_EVERY_SEC)
        _ = asr.unload_if_idle(cfg)
        _ = translate.unload_if_idle(cfg)


def main() -> None:
    cfg = parse_args()
    cfg.mkdirs()
    asr.load_model(cfg)
    translate.cache_load(cfg)
    titles.load(cfg)
    jobs = JobStore(cfg)
    asr.ensure_workers(cfg, jobs)
    log(f"{cfg.workers} transcription worker(s)")
    threading.Thread(target=flush_periodically, args=(cfg,), daemon=True).start()
    # always running: the unload timeout and live translation can be switched on from the dashboard
    threading.Thread(target=janitor, args=(cfg,), daemon=True).start()
    if cfg.mt:
        threading.Thread(target=translate.live_worker, args=(cfg, jobs.active_texts), daemon=True).start()
    server.serve(cfg, jobs)
    log("bye")


if __name__ == "__main__":
    main()
