"""Chinese -> English with a local Marian model, backed by a JSON translation memory."""

import json
import threading
from typing import TYPE_CHECKING

from . import Config, Json, log

if TYPE_CHECKING:
    from opencc import OpenCC
    from transformers import MarianMTModel, MarianTokenizer

_lock = threading.Lock()
_model: "tuple[MarianTokenizer, MarianMTModel] | None" = None
_to_simplified: "OpenCC | None" = None
_cache: dict[str, str] = {}
_dirty = 0

_BATCH = 16
_CACHE_MAX = 50_000
_FLUSH_EVERY = 50


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
    global _dirty
    pair = load(cfg)
    if pair is None:
        return [""] * len(lines)
    tok, mdl = pair
    import torch

    out: list[str | None] = [_cache.get(line) for line in lines]
    todo = [i for i, line in enumerate(lines) if out[i] is None and line.strip()]
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
    if len(_cache) > _CACHE_MAX:
        _cache.clear()
    if _dirty >= _FLUSH_EVERY:
        cache_flush(cfg)
    return [o or "" for o in out]


def info(cfg: Config) -> Json:
    return {"name": cfg.mt, "loaded": _model is not None, "cache_entries": len(_cache), "unsaved": _dirty}
