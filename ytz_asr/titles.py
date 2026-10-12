"""Video titles for the dashboard, from YouTube's oEmbed endpoint, kept in titles.json.

A few dozen short strings: loaded once, fetched one at a time in the background.
"""

import json
import threading
import urllib.request

from . import Config, log, write_json

_lock = threading.Lock()
_titles: dict[str, str] = {}
_pending: set[str] = set()
_fetching = False


def load(cfg: Config) -> None:
    global _titles
    path = cfg.cache / "titles.json"
    if path.exists():
        try:
            _titles = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            log("bad titles file:", e)


def get(cfg: Config, vid: str) -> str | None:
    """The title if known; otherwise queue a fetch and return None for now."""
    global _fetching
    with _lock:
        if vid in _titles:
            return _titles[vid] or None
        _pending.add(vid)
        if _fetching:
            return None
        _fetching = True
    threading.Thread(target=_drain, args=(cfg,), daemon=True).start()
    return None


def _drain(cfg: Config) -> None:
    global _fetching
    while True:
        with _lock:
            if not _pending:
                _fetching = False
                return
            vid = _pending.pop()
        url = f"https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v={vid}"
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                title = str(json.load(r).get("title") or "")
        except Exception as e:  # private or deleted video, or offline: remember the miss
            log(f"{vid}: no title ({e})")
            title = ""
        with _lock:
            _titles[vid] = title
            snapshot = dict(_titles)
        write_json(cfg.cache / "titles.json", snapshot)
