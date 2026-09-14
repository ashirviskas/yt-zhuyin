"""Audio fetching and Whisper transcription, plus the worker loop that drives both."""

import subprocess
import sys
import threading
from contextlib import contextmanager
import time
import traceback
from collections.abc import Iterator
from pathlib import Path
from typing import TYPE_CHECKING

from . import Config, Json, Segment, hub_offline, log, release_memory
from .jobs import JobStore

if TYPE_CHECKING:
    from faster_whisper import WhisperModel
    from opencc import OpenCC

# guards load/unload only. Jobs run concurrently against one shared model, so they
# announce themselves with _inflight rather than holding this for the whole job.
_model_lock = threading.Lock()
_inflight = 0
_model: "WhisperModel | None" = None
_to_tw: "OpenCC | None" = None
_last_used = 0.0

# A punctuated traditional-Chinese prompt nudges whisper into emitting both
# traditional characters AND punctuation.
_PROMPT = "以下是臺灣的繁體中文字幕，有標點符號。大家好，今天我們來聊聊這個話題。"


def load_model(cfg: Config) -> None:
    """Load the weights now. Called at startup; ensure_model() reloads after an unload."""
    global _model, _to_tw, _last_used
    import os

    from faster_whisper import WhisperModel

    with _model_lock:
        log(f"loading faster-whisper '{cfg.model}' (int8, cpu)…")
        # split the cores across workers so parallel jobs don't oversubscribe the CPU
        cores = os.cpu_count() or 4
        opts = {
            "device": "cpu",
            "compute_type": "int8",
            "cpu_threads": max(1, cores // max(1, cfg.workers)),
            "num_workers": max(1, cfg.workers),
        }
        try:
            # already downloaded: skip the Hub round-trip entirely
            with hub_offline():
                _model = WhisperModel(cfg.model, local_files_only=True, **opts)
        except (OSError, ValueError):
            log("not in the local cache, fetching from the Hub (once)…")
            _model = WhisperModel(cfg.model, **opts)
        if _to_tw is None:
            try:
                from opencc import OpenCC

                _to_tw = OpenCC("s2twp")  # simplified -> Taiwan traditional, incl. TW phrasing
            except ImportError as e:
                log("opencc unavailable, output may contain simplified characters:", e)
        _last_used = time.time()
        log("model ready")


def ensure_model(cfg: Config) -> None:
    global _last_used
    with _model_lock:
        if _model is None:
            load_model(cfg)
        _last_used = time.time()


@contextmanager
def model_in_use() -> "Iterator[None]":
    """Mark the model as busy so the janitor leaves it alone while a job runs."""
    global _inflight, _last_used
    with _model_lock:
        _inflight += 1
    try:
        yield
    finally:
        with _model_lock:
            _inflight -= 1
            _last_used = time.time()


def inflight() -> int:
    return _inflight


def unload_if_idle(cfg: Config) -> bool:
    """Drop the weights if nothing has used them lately. Skipped while a job holds the lock."""
    global _model, _last_used
    if not cfg.idle_unload_sec or _model is None or _inflight:
        return False
    if not _model_lock.acquire(blocking=False):
        return False
    try:
        if _model is None or _inflight or time.time() - _last_used < cfg.idle_unload_sec:
            return False
        log(f"whisper idle for {cfg.idle_unload_sec}s, unloading")
        _model = None
        release_memory()
        return True
    finally:
        _model_lock.release()


def model_loaded() -> bool:
    return _model is not None


def _tw(text: str) -> str:
    return _to_tw.convert(text) if _to_tw is not None else text


# ---- audio cache --------------------------------------------------------


def audio_bytes(cfg: Config) -> int:
    return sum(p.stat().st_size for p in cfg.audio.iterdir() if p.is_file())


def audio_files(cfg: Config) -> int:
    return sum(1 for p in cfg.audio.iterdir() if p.is_file())


def evict_audio(cfg: Config) -> None:
    files = sorted((p for p in cfg.audio.iterdir() if p.is_file()), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    while files and total > cfg.audio_max_bytes:
        victim = files.pop(0)
        total -= victim.stat().st_size
        log(f"audio cache: evicting {victim.name}")
        victim.unlink(missing_ok=True)


def download_audio(cfg: Config, vid: str) -> Path:
    """Return the cached audio path, downloading if needed. ~1 MB/min at bestaudio."""
    out = cfg.audio / f"{vid}.m4a"
    if out.exists() and out.stat().st_size > 0:
        out.touch()  # bump mtime for the LRU
        log(f"{vid}: audio from cache")
        return out
    # yt-dlp runs from this interpreter so it works inside uv's env without PATH games
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "-f", "bestaudio[ext=m4a]/bestaudio", "--no-playlist",
        "-o", str(cfg.audio / f"{vid}.%(ext)s"),
        f"https://www.youtube.com/watch?v={vid}",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        tail = r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "unknown"
        raise RuntimeError("yt-dlp failed: " + tail)
    found = sorted(cfg.audio.glob(f"{vid}.*"), key=lambda p: p.stat().st_size, reverse=True)
    if not found:
        raise RuntimeError("yt-dlp produced no file")
    if found[0] != out:
        _ = found[0].rename(out)  # normalise the extension; whisper doesn't care
    evict_audio(cfg)
    return out


# ---- transcription ------------------------------------------------------


def transcribe(
    cfg: Config, jobs: JobStore, vid: str, path: Path
) -> tuple[list[Segment], list[Segment], list[Segment] | None, bool]:
    """Transcribe from the job's resume point. Returns (segs, words, en, finished)."""
    ensure_model(cfg)
    if _model is None:
        raise RuntimeError("model not loaded")
    segs, words, resume_from = jobs.snapshot_progress(vid)
    seg_iter, info = _model.transcribe(
        str(path),
        language="zh",
        task="transcribe",
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
        word_timestamps=True,  # lets the client re-chunk into shorter lines
        clip_timestamps=f"{resume_from:.2f}" if resume_from > 0 else "0",
        initial_prompt=_PROMPT,
    )
    duration = float(info.duration)
    jobs.begin(vid, duration)
    log(
        f"{vid}: audio {duration:.0f}s"
        + (f", resuming at {resume_from:.0f}s" if resume_from else "")
    )

    finished = True
    for s in seg_iter:
        text = s.text.strip()
        if text:
            segs.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": _tw(text)})
            for w in s.words or []:
                wt = w.word.strip()
                if wt:
                    words.append(
                        {"start": round(w.start, 3), "end": round(w.end, 3), "text": _tw(wt)}
                    )
        jobs.record(vid, segs, words, float(s.end), duration)
        if jobs.lease_expired(vid):
            log(f"{vid}: nobody watching for {cfg.lease_sec}s, pausing at {s.end:.0f}s")
            finished = False
            break

    en: list[Segment] | None = None
    if finished and cfg.whisper_translate:
        jobs.mark(vid, "translating")
        seg_iter, _info = _model.transcribe(
            str(path), language="zh", task="translate", beam_size=1, vad_filter=True
        )
        en = [
            {"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()}
            for s in seg_iter
            if s.text.strip()
        ]
    return segs, words, en, finished


def worker(cfg: Config, jobs: JobStore) -> None:
    """One job at a time, forever. Skips jobs nobody is polling for."""
    while True:
        vid = jobs.next_vid()
        if jobs.lease_expired(vid):  # queued but the tab is gone: don't waste CPU
            jobs.mark(vid, "paused")
            log(f"{vid}: skipped (no heartbeat)")
            continue
        try:
            jobs.mark(vid, "downloading")
            audio = download_audio(cfg, vid)
            jobs.mark(vid, "transcribing")
            t0 = time.time()
            with model_in_use():  # keeps the janitor from unloading mid-job
                segs, words, en, finished = transcribe(cfg, jobs, vid, audio)
            if not finished:
                jobs.pause(vid)
                continue
            jobs.finish(vid, segs, words, en, cfg.model)
            log(f"{vid}: done, {len(segs)} segments in {time.time() - t0:.0f}s")
        except Exception as e:  # a bad video must not kill the worker
            traceback.print_exc()
            jobs.fail(vid, str(e))


def info(cfg: Config) -> Json:
    return {
        "name": cfg.model,
        "loaded": _model is not None,
        "device": "cpu",
        "compute_type": "int8",
        "opencc": _to_tw is not None,
        "idle_sec": round(time.time() - _last_used, 1) if _last_used else None,
        "unload_after_sec": cfg.idle_unload_sec or None,
        "workers": cfg.workers,
        "inflight": _inflight,
    }
