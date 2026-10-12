"""Local ASR service for yt-zhuyin: shared config and types."""

import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, TypedDict

type JobStatus = Literal[
    "queued", "downloading", "transcribing", "translating", "paused", "stopped", "ready", "error"
]

type Json = dict[str, Any]


class Segment(TypedDict):
    """One caption line. Sent to the userscript as-is."""

    start: float
    end: float
    text: str


def default_cache() -> Path:
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "yt-zhuyin"


# Settings the dashboard can change while the server runs. Saved to settings.json;
# a flag passed on the command line overrides the saved value for that run.
SETTINGS = (
    "model", "workers", "lease_sec", "idle_unload_sec",
    "live_translate", "whisper_translate", "audio_cache_gb",
)


@dataclass(slots=True)
class Config:
    """Mutable on purpose: the dashboard changes the SETTINGS fields in place and every
    reader picks the new value up on its next loop. Single attribute reads need no lock."""

    model: str = "small"
    port: int = 8765
    whisper_translate: bool = False
    mt: str | None = "Helsinki-NLP/opus-mt-zh-en"
    audio_cache_gb: float = 2.0
    lease_sec: int = 60
    workers: int = 2            # videos transcribed at once
    live_translate: bool = True # translate a job's lines while it is still transcribing
    idle_unload_sec: int = 61    # drop model weights after this much idle; 0 = keep loaded
    cache: Path = field(default_factory=default_cache)
    flags: frozenset[str] = frozenset()  # SETTINGS given on the command line this run

    @property
    def audio_max_bytes(self) -> int:
        return int(self.audio_cache_gb * 1024**3)

    @property
    def settings_file(self) -> Path:
        return self.cache / "settings.json"

    def load_settings(self) -> None:
        if not self.settings_file.exists():
            return
        try:
            saved: Json = json.loads(self.settings_file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            log("bad settings file, using defaults:", e)
            return
        for key in SETTINGS:
            if key in saved and key not in self.flags:
                setattr(self, key, type(getattr(self, key))(saved[key]))

    def save_settings(self) -> None:
        write_json(self.settings_file, {k: getattr(self, k) for k in SETTINGS})

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


def write_json(path: Path, data: object) -> None:
    """Write via a temp file and rename, so a kill mid-write never leaves a truncated file."""
    tmp = path.with_name(path.name + ".tmp")
    _ = tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def release_memory() -> None:
    """Collect, then ask glibc to return freed arenas. Without the trim, RSS barely
    moves after dropping model weights even though the objects are gone."""
    import ctypes
    import gc

    _ = gc.collect()
    try:
        _ = ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):
        pass  # not glibc; gc.collect() alone will have to do


def log(*a: object) -> None:
    print(time.strftime("%H:%M:%S"), *a, flush=True, file=sys.stdout)
