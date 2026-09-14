"""Chinese -> English with a local Marian model, backed by a JSON translation memory."""

import json
import threading
import time
from collections.abc import Callable
from typing import TYPE_CHECKING

from . import Config, Json, hub_offline, log, release_memory

if TYPE_CHECKING:
    from opencc import OpenCC
    from transformers import MarianMTModel, MarianTokenizer

_lock = threading.Lock()
_model: "tuple[MarianTokenizer, MarianMTModel] | None" = None
_to_simplified: "OpenCC | None" = None
_cache: dict[str, str] = {}
_dirty = 0
_last_used = 0.0
_busy = 0          # in-flight generate() calls; the janitor won't unload while non-zero

_BATCH = 16
_CACHE_MAX = 50_000
_FLUSH_EVERY = 50
_LIVE_BATCH = 8          # lines per live pass; small, so a running job keeps most of the CPU
_LIVE_EVERY_SEC = 3.0


def load(cfg: Config) -> "tuple[MarianTokenizer, MarianMTModel] | None":
    """~300 MB of weights, pulled on the first /translate call rather than at startup."""
    global _model, _to_simplified
    with _lock:
        if _model is not None or cfg.mt is None:
            return _model
        import os

        import torch
        import transformers
        from transformers import MarianMTModel, MarianTokenizer

        transformers.utils.logging.set_verbosity_error()  # silence per-call generation warnings
        torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))
        log(f"loading MT '{cfg.mt}'…")
        transformers.utils.logging.disable_progress_bar()   # local weight loading needs no bar
        try:
            # already downloaded: skip the Hub round-trip (and its rate-limit warning)
            with hub_offline():
                tok = MarianTokenizer.from_pretrained(cfg.mt, local_files_only=True)
                mdl = MarianMTModel.from_pretrained(cfg.mt, local_files_only=True).eval()
        except OSError:
            log("not in the local cache, fetching from the Hub (once)…")
            tok = MarianTokenizer.from_pretrained(cfg.mt)
            mdl = MarianMTModel.from_pretrained(cfg.mt).eval()
        try:
            from opencc import OpenCC

            # the MT model was trained mostly on simplified text
            _to_simplified = OpenCC("t2s")
        except ImportError as e:
            log("opencc unavailable for MT input:", e)
        _model = (tok, mdl)
        log("MT ready")
        return _model


def loaded() -> bool:
    return _model is not None


def busy() -> bool:
    return _busy > 0


def unload_if_idle(cfg: Config) -> bool:
    """Drop the ~300 MB of Marian weights if nothing has translated lately."""
    global _model
    if not cfg.idle_unload_sec or _model is None or _busy:
        return False
    if time.time() - _last_used < cfg.idle_unload_sec:
        return False
    with _lock:
        if _model is None or _busy:
            return False
        log(f"MT idle for {cfg.idle_unload_sec}s, unloading")
        _model = None
        release_memory()
    cache_flush(cfg)
    return True


def cache_load(cfg: Config) -> None:
    global _cache
    if not cfg.mt_cache_file.exists():
        return
    try:
        _cache = json.loads(cfg.mt_cache_file.read_text(encoding="utf-8"))
        log(f"MT cache: {len(_cache)} entries")
    except (OSError, ValueError) as e:
        log("bad MT cache file:", e)


def cache_flush(cfg: Config) -> None:
    global _dirty
    if not _dirty:
        return
    try:
        _ = cfg.mt_cache_file.write_text(json.dumps(_cache, ensure_ascii=False), encoding="utf-8")
        _dirty = 0
    except OSError as e:
        log("MT cache write failed:", e)


def translate(cfg: Config, lines: list[str]) -> list[str]:
    global _dirty, _busy, _last_used
    # busy from here, not just around generation: loading the weights is the slow part,
    # and the dashboard should show that as work rather than as idle
    _busy += 1
    _last_used = time.time()
    try:
        pair = load(cfg)
        if pair is None:
            return [""] * len(lines)
        tok, mdl = pair
        out: list[str | None] = [_cache.get(line) for line in lines]
        todo = [i for i, line in enumerate(lines) if out[i] is None and line.strip()]
        _translate_missing(tok, mdl, lines, out, todo)
    finally:
        _busy -= 1
        _last_used = time.time()
    if len(_cache) > _CACHE_MAX:
        _cache.clear()
    if _dirty >= _FLUSH_EVERY:
        cache_flush(cfg)
    return [o or "" for o in out]


def _translate_missing(
    tok: "MarianTokenizer",
    mdl: "MarianMTModel",
    lines: list[str],
    out: list[str | None],
    todo: list[int],
) -> None:
    global _dirty
    import torch

    for start in range(0, len(todo), _BATCH):
        idx = todo[start : start + _BATCH]
        src = [
            _to_simplified.convert(lines[i]) if _to_simplified is not None else lines[i]
            for i in idx
        ]
        with torch.inference_mode():
            enc = tok(src, return_tensors="pt", padding=True, truncation=True, max_length=128)
            # max_length only, so transformers doesn't warn about max_new_tokens.
            # transformers' own stubs don't admit MarianMTModel to their
            # GenerativePreTrainedModel protocol, so .generate() needs the escape.
            gen = mdl.generate(**enc, num_beams=2, max_length=160)  # pyright: ignore[reportAttributeAccessIssue]
        for i, text in zip(idx, tok.batch_decode(gen, skip_special_tokens=True)):
            out[i] = _cache[lines[i]] = text.strip()
            _dirty += 1


def live_worker(cfg: Config, pending: Callable[[], list[str]]) -> None:
    """Translate a job's lines while it is still being transcribed.

    Without this, translation only starts once someone asks for English — usually
    after the job has finished. Running it alongside means the English is already
    cached by the time the transcript is complete.
    """
    while True:
        time.sleep(_LIVE_EVERY_SEC)
        try:
            todo = [t for t in dict.fromkeys(pending()) if t.strip() and t not in _cache]
            if todo:
                _ = translate(cfg, todo[:_LIVE_BATCH])
        except Exception as e:  # never take the thread down over one bad batch
            log("live translate failed:", e)


def preview(cfg: Config, lines: list[str], budget: int) -> list[str]:
    """English for the dashboard: whatever is cached, plus at most `budget` new lines.

    A poll must stay cheap, so the rest fill in over the following polls rather
    than blocking this one behind a few hundred translations.
    """
    out = [_cache.get(line, "") for line in lines]
    missing = [i for i, line in enumerate(lines) if not out[i] and line.strip()]
    if missing and cfg.mt is not None:
        todo = missing[:budget]
        for i, text in zip(todo, translate(cfg, [lines[i] for i in todo])):
            out[i] = text
    return out


def info(cfg: Config) -> Json:
    return {
        "name": cfg.mt,
        "loaded": _model is not None,
        "busy": _busy > 0,
        "cache_entries": len(_cache),
        "unsaved": _dirty,
        "idle_sec": round(time.time() - _last_used, 1) if _last_used else None,
        "unload_after_sec": cfg.idle_unload_sec or None,
    }
