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
    DELETE /transcript/<videoId>[?audio=1]  -> drop the cache entry (and its audio)

First GET for a video starts the job; subsequent GETs return progress (segments so far) and act as a
heartbeat. If no GET arrives for --lease-sec (default 60) the job is paused after its current segment and
its partial result kept; the next GET resumes from where it stopped. Queued jobs nobody is polling for
are skipped the same way, so closing the tab stops the CPU burn within a minute.
Results are cached in ~/.cache/yt-zhuyin/<videoId>.json; downloaded audio in ~/.cache/yt-zhuyin/audio/ (LRU, --audio-cache-gb).

Code lives in ytz_asr/: jobs.py (state), asr.py (audio + whisper), translate.py (zh->en), server.py (HTTP).
"""

import argparse
import threading
import time

from ytz_asr import Config, log
from ytz_asr import asr, server, translate
from ytz_asr.jobs import JobStore

FLUSH_EVERY_SEC = 30


def parse_args() -> Config:
    p = argparse.ArgumentParser(description="Local Whisper ASR + translation service for yt-zhuyin.")
    _ = p.add_argument("--model", default="small",
                       help="faster-whisper model: tiny/base/small/medium/large-v3 or a HF repo id")
    _ = p.add_argument("--port", type=int, default=8765)
    _ = p.add_argument("--translate", action="store_true",
                       help="also produce whisper's own English pass (doubles CPU time; usually worse than /translate)")
    _ = p.add_argument("--mt", default="Helsinki-NLP/opus-mt-zh-en",
                       help="HF Marian model for /translate, or 'none' to disable")
    _ = p.add_argument("--audio-cache-gb", type=float, default=2.0,
                       help="keep downloaded audio up to this size (LRU), 0 = don't keep")
    _ = p.add_argument("--lease-sec", type=int, default=60,
                       help="pause a job if no client polled it for this long")
    a = p.parse_args()
    return Config(
        model=str(a.model),
        port=int(a.port),
        whisper_translate=bool(a.translate),
        mt=None if str(a.mt).lower() == "none" else str(a.mt),
        audio_max_bytes=int(float(a.audio_cache_gb) * 1024**3),
        lease_sec=int(a.lease_sec),
    )


def flush_periodically(cfg: Config) -> None:
    while True:
        time.sleep(FLUSH_EVERY_SEC)
        translate.cache_flush(cfg)


def main() -> None:
    cfg = parse_args()
    cfg.mkdirs()
    asr.load_model(cfg)
    translate.cache_load(cfg)
    jobs = JobStore(cfg)
    threading.Thread(target=asr.worker, args=(cfg, jobs), daemon=True).start()
    threading.Thread(target=flush_periodically, args=(cfg,), daemon=True).start()
    server.serve(cfg, jobs)
    log("bye")


if __name__ == "__main__":
    main()
