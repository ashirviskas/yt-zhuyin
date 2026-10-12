"""Audio fetching and Whisper transcription, plus the worker loop that drives both."""

import subprocess
import sys
import threading
from contextlib import contextmanager
import time
import traceback
from collections.abc import Iterator
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import Config, Json, Segment, log, release_memory
from .jobs import Halt, JobStore

if TYPE_CHECKING:
    import numpy as np
    from faster_whisper import WhisperModel
    from opencc import OpenCC

# guards load/unload only. Jobs run concurrently against one shared model, so they
# announce themselves with _inflight rather than holding this for the whole job.
_model_lock = threading.Lock()
_inflight = 0
_model: "WhisperModel | None" = None
_loaded_as: tuple[str, int] | None = None   # (model name, workers) the weights were loaded for
_to_tw: "OpenCC | None" = None
_last_used = 0.0

# A punctuated traditional-Chinese prompt nudges whisper into emitting both
# traditional characters AND punctuation.
_PROMPT = "以下是臺灣的繁體中文字幕，有標點符號。大家好，今天我們來聊聊這個話題。"


def load_model(cfg: Config) -> None:
    """Load the weights now. Called at startup; ensure_model() reloads after an unload."""
    with _model_lock:
        _load(cfg)


def _load(cfg: Config) -> None:
    """Call with _model_lock held."""
    global _model, _loaded_as, _to_tw, _last_used
    import os

    from faster_whisper import WhisperModel

    log(f"loading faster-whisper '{cfg.model}' (int8, cpu)…")
    # split the cores across workers so parallel jobs don't oversubscribe the CPU.
    # num_workers keeps one model replica per worker: more workers, more RAM
    cores = os.cpu_count() or 4
    opts = {
        "device": "cpu",
        "compute_type": "int8",
        "cpu_threads": max(1, cores // max(1, cfg.workers)),
        "num_workers": max(1, cfg.workers),
    }
    try:
        # already downloaded: local_files_only skips the Hub round-trip entirely
        _model = WhisperModel(cfg.model, local_files_only=True, **opts)
    except (OSError, ValueError):
        log("not in the local cache, fetching from the Hub (once)…")
        _model = WhisperModel(cfg.model, **opts)
    _loaded_as = (cfg.model, cfg.workers)
    if _to_tw is None:
        try:
            from opencc import OpenCC

            _to_tw = OpenCC("s2twp")  # simplified -> Taiwan traditional, incl. TW phrasing
        except ImportError as e:
            log("opencc unavailable, output may contain simplified characters:", e)
    _last_used = time.time()
    log("model ready")


def _stale(cfg: Config) -> bool:
    return _model is not None and _loaded_as != (cfg.model, cfg.workers)


def ensure_model(cfg: Config) -> "WhisperModel":
    """The model for the current settings. Called inside model_in_use(), so _inflight
    counts this job: a settings change swaps the weights only when no other job uses them,
    and the old ones are dropped before the new ones load. Never two models in memory."""
    global _model, _last_used
    with _model_lock:
        if _stale(cfg) and _inflight <= 1:
            log(f"settings changed, swapping {_loaded_as} for {(cfg.model, cfg.workers)}")
            _model = None
            release_memory()
        if _model is None:
            _load(cfg)
        _last_used = time.time()
        assert _model is not None
        return _model


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
    """Drop the weights if nothing has used them lately, or right away if the settings
    moved on from them. Never while a job runs."""
    global _model, _loaded_as
    if _model is None or _inflight:
        return False
    if not _stale(cfg) and not cfg.idle_unload_sec:
        return False
    if not _model_lock.acquire(blocking=False):
        return False
    try:
        if _model is None or _inflight:
            return False
        if _stale(cfg):
            log("settings changed, unloading whisper until the next job")
        elif time.time() - _last_used >= cfg.idle_unload_sec:
            log(f"whisper idle for {cfg.idle_unload_sec}s, unloading")
        else:
            return False
        _model, _loaded_as = None, None
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


# ---- windowed decoding --------------------------------------------------
# Handing faster-whisper a file makes it decode all of it (int16, then a float32 copy) and
# build mel features for all of it in one go: measured ~0.75 MB per audio second at peak,
# 2.5 GB for a 56-minute stream. One window at a time keeps it near +100 MB at any length.

RATE = 16000
WINDOW_SEC = 120.0  # mel features cost ~0.75 MB per audio second while they are built
_EDGE_SEC = 2.0   # a segment ending this close to the window edge may be cut off: redo it in the next window


def audio_duration(path: Path) -> float:
    import av

    with av.open(str(path), metadata_errors="ignore") as c:
        stream = c.streams.audio[0]
        if stream.duration is not None and stream.time_base is not None:
            return float(stream.duration * stream.time_base)
        return (c.duration or 0) / 1e6


def decode_window(path: Path, start: float, length: float) -> "np.ndarray":
    """Mono float32 at 16 kHz for [start, start + length)."""
    import av
    import numpy as np

    need = int(length * RATE)
    parts: list[np.ndarray] = []
    got = 0
    resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE)
    with av.open(str(path), metadata_errors="ignore") as c:
        stream = c.streams.audio[0]
        if start > 0 and stream.time_base is not None:
            c.seek(int(start / stream.time_base), stream=stream)  # lands on a packet at or before start
        for frame in c.decode(stream):
            t0 = float(frame.time or 0.0)
            for out in resampler.resample(frame):
                pcm = out.to_ndarray().reshape(-1)
                if t0 < start:  # the seek undershot: drop what lies before start
                    pcm = pcm[int((start - t0) * RATE):]
                if pcm.size:
                    parts.append(pcm[: need - got])
                    got += parts[-1].size
            if got >= need:
                break
    del resampler
    release_memory()  # PyAV resampler objects linger otherwise (faster-whisper#390)
    if not parts:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(parts).astype(np.float32) / 32768.0


def _windows(model: "WhisperModel", path: Path, start: float, duration: float, **opts: object) -> "Iterator[tuple[float, Any]]":
    """Whisper segments from `start` to the end, one window at a time. Yields (offset, segment):
    segment times are relative to the window, add the offset."""
    pos = start
    while pos < duration - 0.5:
        audio = decode_window(path, pos, WINDOW_SEC)
        if audio.size < RATE // 2:
            return
        edge = pos + audio.size / RATE
        last = edge >= duration - 0.5
        nxt = edge
        seg_iter, _info = model.transcribe(audio, **opts)  # pyright: ignore[reportArgumentType]
        for seg in seg_iter:
            if not last and pos + seg.end > edge - _EDGE_SEC:
                nxt = pos + seg.start  # possibly cut mid-word: start the next window here
                break
            yield pos, seg
        del audio
        pos = nxt if nxt > pos + 1.0 else edge  # always move forward


def transcribe(cfg: Config, jobs: JobStore, vid: str, path: Path) -> tuple[list[Segment] | None, Halt]:
    """Transcribe from the job's resume point into the job itself. Returns (en, why it stopped early)."""
    model = ensure_model(cfg)
    duration = audio_duration(path)
    resume_from = jobs.begin(vid, duration)
    log(f"{vid}: audio {duration:.0f}s" + (f", resuming at {resume_from:.0f}s" if resume_from else ""))

    for off, s in _windows(
        model, path, resume_from, duration,
        language="zh",
        task="transcribe",
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
        word_timestamps=True,  # lets the client re-chunk into shorter lines
        initial_prompt=_PROMPT,
    ):
        text = s.text.strip()
        seg: Segment | None = None
        words: list[Segment] = []
        if text:
            seg = {"start": round(off + s.start, 3), "end": round(off + s.end, 3), "text": _tw(text)}
            words = [
                {"start": round(off + w.start, 3), "end": round(off + w.end, 3), "text": _tw(w.word.strip())}
                for w in s.words or []
                if w.word.strip()
            ]
        jobs.add(vid, seg, words, off + float(s.end))
        if why := jobs.halt(vid):
            log(f"{vid}: {'stopped' if why == 'stop' else f'nobody watching for {cfg.lease_sec}s'}, pausing at {off + s.end:.0f}s")
            return None, why

    en: list[Segment] | None = None
    if cfg.whisper_translate:
        jobs.mark(vid, "translating")
        en = [
            {"start": round(off + s.start, 3), "end": round(off + s.end, 3), "text": s.text.strip()}
            for off, s in _windows(model, path, 0.0, duration, language="zh", task="translate", beam_size=1, vad_filter=True)
            if s.text.strip()
        ]
    return en, None


# ---- workers ------------------------------------------------------------

_workers_lock = threading.Lock()
_workers: set[int] = set()


def ensure_workers(cfg: Config, jobs: JobStore) -> None:
    """Start worker threads up to cfg.workers. Surplus ones retire on their own."""
    with _workers_lock:
        for n in range(cfg.workers):
            if n not in _workers:
                _workers.add(n)
                threading.Thread(target=worker, args=(cfg, jobs, n), name=f"worker-{n}", daemon=True).start()


def _retire(cfg: Config, n: int) -> bool:
    with _workers_lock:
        if n < cfg.workers:
            return False
        _workers.discard(n)
        return True


def worker(cfg: Config, jobs: JobStore, n: int) -> None:
    """One job at a time until the worker count drops below n. Skips jobs nobody wants."""
    while not _retire(cfg, n):
        vid = jobs.next_vid()
        if _retire(cfg, n):
            jobs.requeue_front(vid)
            return
        if why := jobs.halt(vid):  # queued but the tab is gone, or stop pressed: don't waste CPU
            jobs.pause(vid, "stopped" if why == "stop" else "paused")
            log(f"{vid}: skipped ({'stopped' if why == 'stop' else 'no heartbeat'})")
            continue
        try:
            jobs.mark(vid, "downloading")
            audio = download_audio(cfg, vid)
            if why := jobs.halt(vid):
                jobs.pause(vid, "stopped" if why == "stop" else "paused")
                continue
            jobs.mark(vid, "transcribing")
            t0 = time.time()
            with model_in_use():  # keeps the janitor from unloading mid-job
                en, why = transcribe(cfg, jobs, vid, audio)
            if why:
                jobs.pause(vid, "stopped" if why == "stop" else "paused")
                continue
            lines = jobs.finish(vid, en, cfg.model)
            log(f"{vid}: done, {lines} segments in {time.time() - t0:.0f}s")
        except Exception as e:  # a bad video must not kill the worker
            traceback.print_exc()
            jobs.fail(vid, str(e))


def info(cfg: Config) -> Json:
    return {
        "name": cfg.model,
        "loaded": _model is not None,
        "loaded_as": _loaded_as[0] if _loaded_as else None,
        "device": "cpu",
        "compute_type": "int8",
        "opencc": _to_tw is not None,
        "idle_sec": round(time.time() - _last_used, 1) if _last_used else None,
        "unload_after_sec": cfg.idle_unload_sec or None,
        "workers": cfg.workers,
        "inflight": _inflight,
    }
