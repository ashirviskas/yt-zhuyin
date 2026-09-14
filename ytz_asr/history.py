"""A rolling window of what the server was doing, for the dashboard charts."""

import threading
import time
from collections.abc import Callable
from collections import deque
from dataclasses import dataclass

from . import Json, log

SAMPLE_SEC = 2.0
KEEP = 900  # 30 minutes at SAMPLE_SEC

# charted states, stacked bottom to top; everything else is idle time
STATES = ("transcribing", "downloading", "queued", "translating")


@dataclass(frozen=True, slots=True)
class Sample:
    t: float
    rss_mb: float
    counts: dict[str, int]   # how many of each state were running at this instant


_lock = threading.Lock()
_samples: deque[Sample] = deque(maxlen=KEEP)

type Reading = tuple[float, dict[str, int], bool]


def record(rss_mb: float, totals: dict[str, int], translating: bool) -> None:
    counts = {s: int(totals.get(s, 0)) for s in STATES}
    counts["translating"] = 1 if translating else 0
    with _lock:
        _samples.append(Sample(time.time(), rss_mb, counts))


def series(limit: int = KEEP) -> Json:
    with _lock:
        rows = list(_samples)[-limit:]
    return {
        "sample_sec": SAMPLE_SEC,
        "states": list(STATES),
        "t": [round(s.t, 1) for s in rows],
        "rss_mb": [round(s.rss_mb, 1) for s in rows],
        "counts": {st: [s.counts.get(st, 0) for s in rows] for st in STATES},
    }


def sampler(read: Callable[[], Reading]) -> None:
    """Take one reading every SAMPLE_SEC, forever."""
    while True:
        try:
            record(*read())
        except Exception as e:  # a sampling hiccup must not kill the thread
            log("history sample failed:", e)
        time.sleep(SAMPLE_SEC)
