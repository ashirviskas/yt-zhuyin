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

First GET for a video starts the job; subsequent GETs return progress (segments so far) and act as a
heartbeat. If no GET arrives for --lease-sec (default 60) the job is paused after its current segment and
its partial result kept; the next GET resumes from where it stopped. Queued jobs nobody is polling for
are skipped the same way, so closing the tab stops the CPU burn within a minute.
Results are cached in ~/.cache/yt-zhuyin/<videoId>.json; downloaded audio in ~/.cache/yt-zhuyin/audio/ (LRU, --audio-cache-gb).

Code lives in ytz_asr/: jobs.py (state), asr.py (audio + whisper), translate.py (zh->en),
server.py (FastAPI routes), dashboard.py (the HTML).
"""

import argparse
import threading
import time

from ytz_asr import Config, log
from ytz_asr import asr, server, translate
from ytz_asr.jobs import JobStore

FLUSH_EVERY_SEC = 30
JANITOR_EVERY_SEC = 15


def parse_args() -> Config:
    p = argparse.ArgumentParser(description="Local Whisper ASR + translation service for yt-zhuyin.")
    _ = p.add_argument("--model", default="small",
                       help="faster-whisper model: tiny/base/small/medium/large-v3 or a HF repo id")
    _ = p.add_argument("--port", type=int, default=8765)
    _ = p.add_argument("--workers", type=int, default=2,
                       help="videos transcribed at once; CPU cores are split between them")
    _ = p.add_argument("--translate", action="store_true",
                       help="also produce whisper's own English pass (doubles CPU time; usually worse than /translate)")
    _ = p.add_argument("--mt", default="Helsinki-NLP/opus-mt-zh-en",
                       help="HF Marian model for /translate, or 'none' to disable")
    _ = p.add_argument("--no-live-translate", action="store_true",
                       help="only translate on request, instead of alongside transcription")
    _ = p.add_argument("--audio-cache-gb", type=float, default=2.0,
                       help="keep downloaded audio up to this size (LRU), 0 = don't keep")
    _ = p.add_argument("--lease-sec", type=int, default=60,
                       help="pause a job if no client polled it for this long")
    _ = p.add_argument("--idle-unload-sec", type=int, default=61,
                       help="drop model weights after this many idle seconds, 0 = keep loaded")
    a = p.parse_args()
    return Config(
        model=str(a.model),
        port=int(a.port),
        workers=max(1, int(a.workers)),
        whisper_translate=bool(a.translate),
        mt=None if str(a.mt).lower() == "none" else str(a.mt),
        live_translate=not bool(a.no_live_translate),
        audio_max_bytes=int(float(a.audio_cache_gb) * 1024**3),
        lease_sec=int(a.lease_sec),
        idle_unload_sec=int(a.idle_unload_sec),
    )


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
    jobs = JobStore(cfg)
    for n in range(cfg.workers):
        threading.Thread(target=asr.worker, args=(cfg, jobs), name=f"worker-{n}", daemon=True).start()
    log(f"{cfg.workers} transcription worker(s)")
    threading.Thread(target=flush_periodically, args=(cfg,), daemon=True).start()
    if cfg.idle_unload_sec:
        threading.Thread(target=janitor, args=(cfg,), daemon=True).start()
    if cfg.mt and cfg.live_translate:
        threading.Thread(target=translate.live_worker, args=(cfg, jobs.active_texts), daemon=True).start()
    server.serve(cfg, jobs)
    log("bye")


if __name__ == "__main__":
    main()
