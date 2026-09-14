"""Local ASR service for yt-zhuyin: shared config and types."""

import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, TypedDict

type JobStatus = Literal[
    "queued", "downloading", "transcribing", "translating", "paused", "ready", "error"
]

type Json = dict[str, Any]


class Segment(TypedDict):
    """One caption line. Sent to the userscript as-is."""

    start: float
    end: float
    text: str


def default_cache() -> Path:
    import os

    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "yt-zhuyin"


@dataclass(frozen=True, slots=True)
class Config:
    model: str = "small"
    port: int = 8765
    whisper_translate: bool = False
    mt: str | None = "Helsinki-NLP/opus-mt-zh-en"
    audio_max_bytes: int = 2 * 1024**3
    lease_sec: int = 60
    cache: Path = field(default_factory=default_cache)

    @property
    def audio(self) -> Path:
        return self.cache / "audio"

    @property
    def mt_cache_file(self) -> Path:
        return self.cache / "mt_cache.json"

    def result(self, vid: str) -> Path:
        return self.cache / f"{vid}.json"

    def partial(self, vid: str) -> Path:
        return self.cache / f"{vid}.partial.json"

    def mkdirs(self) -> None:
        self.cache.mkdir(parents=True, exist_ok=True)
        self.audio.mkdir(exist_ok=True)


def log(*a: object) -> None:
    print(time.strftime("%H:%M:%S"), *a, flush=True, file=sys.stdout)
