"""Job bookkeeping: the in-flight videos, the queue, and the one lock guarding both."""

import json
import threading
import time
from dataclasses import dataclass, field
from typing import Literal

from . import Config, Json, JobStatus, Segment, log, write_json

CHECKPOINT_SEC = 30  # most work a crash or kill -9 can cost

type Halt = Literal["stop", "lease"] | None


@dataclass(slots=True)
class Job:
    """One video being transcribed. `words` feed the userscript's re-chunker.

    The worker appends to `segs`/`words` in place; once the result is on disk they are
    emptied and only the counts stay, so finished jobs cost no memory.
    """

    vid: str
    status: JobStatus = "queued"
    segs: list[Segment] = field(default_factory=list)
    words: list[Segment] = field(default_factory=list)
    n_segs: int = 0
    n_words: int = 0
    en: list[Segment] | None = None
    done: bool = False
    progress: float = 0.0
    resume_from: float = 0.0
    audio_duration: float = 0.0
    created_at: float = field(default_factory=time.time)
    started_at: float = 0.0
    last_seen: float = field(default_factory=time.time)
    saved_at: float = field(default_factory=time.time)
    forced: bool = False   # started from the dashboard: runs without a polling tab
    stop: bool = False     # stop pressed: pause after the current segment, don't auto-resume
    error: str | None = None

    def client_view(self) -> Json:
        """The /transcript payload. Keys here are load-bearing for the userscript."""
        view: Json = {
            "status": self.status,
            "segs": self.segs,
            "words": self.words,
            "en": self.en,
            "done": self.done,
            "progress": self.progress,
            "resume_from": self.resume_from,
            "t": self.created_at,
        }
        if self.error is not None:
            view["error"] = self.error
        return view

    def status_view(self, now: float, lease_sec: int) -> Json:
        """The richer /status entry: timings, throughput, how long the lease has left."""
        elapsed = now - self.started_at if self.started_at else 0.0
        speed = self.resume_from / elapsed if elapsed > 0.5 and self.resume_from else None
        remaining = self.audio_duration - self.resume_from
        eta = remaining / speed if speed and remaining > 0 else None
        idle = now - self.last_seen
        return {
            "vid": self.vid,
            "status": self.status,
            "progress": round(self.progress, 3),
            "segments": len(self.segs) or self.n_segs,
            "words": len(self.words) or self.n_words,
            "audio_duration_sec": round(self.audio_duration, 1) or None,
            "transcribed_sec": round(self.resume_from, 1),
            "elapsed_sec": round(elapsed, 1) if elapsed else None,
            "speed_x": round(speed, 2) if speed and not self.done else None,
            "eta_sec": round(eta) if eta and not self.done else None,
            "age_sec": round(now - self.created_at, 1),
            "last_seen_sec_ago": round(idle, 1),
            "lease_expires_in_sec": None if self.forced else round(max(0.0, lease_sec - idle), 1),
            "forced": self.forced,
            "error": self.error,
        }

    def partial_data(self) -> Json:
        """Shallow copies, so the file can be written outside the lock while the worker appends."""
        return {
            "vid": self.vid,
            "segs": list(self.segs),
            "words": list(self.words),
            "resume_from": self.resume_from,
            "audio_duration": self.audio_duration,
            "t": time.time(),
        }


class JobStore:
    """All mutable job state. One lock; the condition shares it so there is no ordering to get wrong."""

    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg
        self._cv = threading.Condition()
        self._jobs: dict[str, Job] = {}
        self._queue: list[str] = []

    # ---- client side ----------------------------------------------------

    def request(self, vid: str) -> Json:
        """Start the job, or heartbeat it and report progress. Resumes a paused one,
        never a stopped or failed one: those wait for an explicit start."""
        cached = self._cfg.result(vid)
        if cached.exists():
            d: Json = json.loads(cached.read_text(encoding="utf-8"))
            return {
                "status": "ready",
                "segs": d["segs"],
                "words": d.get("words"),
                "en": d.get("en"),
                "done": True,
                "progress": 1.0,
                "cached": True,
            }
        with self._cv:
            job = self._jobs.get(vid)
            if job is None:
                job = self._new(vid)
                self._enqueue(job)
            else:
                job.last_seen = time.time()
                if job.status == "paused":
                    self._enqueue(job)
            return job.client_view()

    def start(self, vid: str, force: bool) -> None:
        """Start or resume, from the dashboard (force: no tab needed) or the userscript."""
        if self._cfg.result(vid).exists():
            return
        with self._cv:
            job = self._jobs.get(vid)
            if job is None:
                job = self._new(vid)
                job.status = "paused"   # so the check below queues it
            job.stop = False
            job.forced = job.forced or force
            job.last_seen = time.time()
            if job.status in ("paused", "stopped", "error"):
                job.error, job.done = None, False
                self._enqueue(job)

    def stop(self, vid: str) -> None:
        """Pause after the current segment and keep what we have. A queued job leaves the queue."""
        with self._cv:
            job = self._jobs.get(vid)
            if job is None or job.done:
                return
            job.stop, job.forced = True, False
            if vid in self._queue:
                self._queue.remove(vid)
                job.status = "stopped"
            elif job.status == "paused":
                job.status = "stopped"

    def forget(self, vid: str, drop_audio: bool) -> None:
        """Drop everything. A running worker notices the job is gone and moves on."""
        with self._cv:
            _ = self._jobs.pop(vid, None)
            if vid in self._queue:
                self._queue.remove(vid)
        self._cfg.result(vid).unlink(missing_ok=True)
        self._cfg.partial(vid).unlink(missing_ok=True)
        if drop_audio:
            (self._cfg.audio / f"{vid}.m4a").unlink(missing_ok=True)

    # ---- worker side ----------------------------------------------------

    def next_vid(self) -> str:
        with self._cv:
            while not self._queue:
                _ = self._cv.wait()
            return self._queue.pop(0)

    def requeue_front(self, vid: str) -> None:
        """Hand a job back untouched, for a worker that is shutting down."""
        with self._cv:
            if vid in self._jobs and vid not in self._queue:
                self._queue.insert(0, vid)
                self._cv.notify()

    def mark(self, vid: str, status: JobStatus) -> None:
        with self._cv:
            if job := self._jobs.get(vid):
                job.status = status

    def resume_point(self, vid: str) -> float:
        with self._cv:
            job = self._jobs.get(vid)
            return job.resume_from if job else 0.0

    def begin(self, vid: str, duration: float) -> float:
        """Timing starts here. Returns where to resume."""
        with self._cv:
            job = self._jobs.get(vid)
            if job is None:
                return 0.0
            job.started_at = time.time()
            job.audio_duration = duration
            return job.resume_from

    def add(self, vid: str, seg: Segment | None, words: list[Segment], end: float) -> None:
        """One decoded segment. Checkpoints to disk every CHECKPOINT_SEC."""
        with self._cv:
            job = self._jobs.get(vid)
            if job is None:
                return
            if seg is not None:
                job.segs.append(seg)
                job.words.extend(words)
            job.resume_from = end
            job.progress = round(end / job.audio_duration, 3) if job.audio_duration else 0.0
            now = time.time()
            data = job.partial_data() if now - job.saved_at >= CHECKPOINT_SEC else None
            if data is not None:
                job.saved_at = now
        if data is not None:
            write_json(self._cfg.partial(vid), data)

    def halt(self, vid: str) -> Halt:
        """Why the worker should stop now, if it should. A deleted job counts as stopped."""
        with self._cv:
            job = self._jobs.get(vid)
            if job is None or job.stop:
                return "stop"
            if not job.forced and time.time() - job.last_seen > self._cfg.lease_sec:
                return "lease"
            return None

    def finish(self, vid: str, en: list[Segment] | None, model: str) -> int:
        """Write the result and let go of the lines. Returns the line count."""
        with self._cv:
            job = self._jobs.get(vid)
            if job is None:
                return 0
            segs, words = job.segs, job.words
        result: Json = {"vid": vid, "segs": segs, "words": words, "en": en, "model": model, "t": time.time()}
        write_json(self._cfg.result(vid), result)
        self._cfg.partial(vid).unlink(missing_ok=True)
        with self._cv:
            job.n_segs, job.n_words = len(segs), len(words)
            job.segs, job.words, job.en = [], [], None
            job.status, job.done, job.progress, job.forced = "ready", True, 1.0, False
            job.resume_from = max(job.resume_from, job.audio_duration)  # silence at the end, or no speech at all
        return len(segs)

    def fail(self, vid: str, message: str) -> None:
        """Keep the partial, so a retry resumes instead of starting over."""
        self.pause(vid, "error")
        with self._cv:
            if job := self._jobs.get(vid):
                job.error, job.done = message, True

    def pause(self, vid: str, status: Literal["paused", "stopped", "error"]) -> None:
        """Stop work and keep what we have."""
        with self._cv:
            job = self._jobs.get(vid)
            if job is None:
                return
            job.status = status
            data = job.partial_data() if job.segs else None
        if data is not None:
            write_json(self._cfg.partial(vid), data)

    def checkpoint_all(self) -> None:
        """On shutdown: every job with lines in memory goes to disk."""
        with self._cv:
            todo = [(j.vid, j.partial_data()) for j in self._jobs.values() if not j.done and j.segs]
        for vid, data in todo:
            write_json(self._cfg.partial(vid), data)
        if todo:
            log(f"checkpointed {len(todo)} running job(s)")

    # ---- reading --------------------------------------------------------

    def preview(self, vid: str, limit: int) -> tuple[list[Segment], int, bool]:
        """Lines for the dashboard. A live job shows its tail, anything else its start."""
        with self._cv:
            job = self._jobs.get(vid)
            segs = list(job.segs) if job else []
            live = job is not None and job.status == "transcribing"
        if not segs:
            live = False
            for path in (self._cfg.result(vid), self._cfg.partial(vid)):
                if path.exists():
                    try:
                        segs = json.loads(path.read_text(encoding="utf-8")).get("segs") or []
                        break
                    except (OSError, ValueError) as e:
                        log("bad transcript file:", e)
        total = len(segs)
        window = segs[-limit:] if live else segs[:limit]
        return window, total, live

    def active_texts(self) -> list[str]:
        """Lines from jobs that are transcribing right now, so they can be translated ahead of time."""
        with self._cv:
            return [seg["text"] for job in self._jobs.values() if job.status == "transcribing" for seg in job.segs]

    def states(self) -> dict[str, JobStatus]:
        with self._cv:
            return {vid: j.status for vid, j in self._jobs.items()}

    def report(self) -> tuple[list[Json], list[str], dict[str, int]]:
        now = time.time()
        with self._cv:
            jobs = [j.status_view(now, self._cfg.lease_sec) for j in self._jobs.values()]
            queue = list(self._queue)
        totals: dict[str, int] = {}
        for j in jobs:
            key = str(j["status"])
            totals[key] = totals.get(key, 0) + 1
        return jobs, queue, totals

    # ---- internals (call with the lock held) ----------------------------

    def _new(self, vid: str) -> Job:
        job = self._jobs[vid] = Job(vid=vid)
        self._load_partial(job)
        return job

    def _enqueue(self, job: Job) -> None:
        job.status = "queued"
        if job.vid not in self._queue:
            self._queue.append(job.vid)
            self._cv.notify()

    def _load_partial(self, job: Job) -> None:
        """Survive a server restart mid-video."""
        path = self._cfg.partial(job.vid)
        if not path.exists():
            return
        try:
            d: Json = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            log("bad partial file:", e)
            return
        job.segs = d["segs"]
        job.words = d["words"]
        job.resume_from = float(d.get("resume_from", 0.0))
        job.audio_duration = float(d.get("audio_duration", 0.0))
        if job.audio_duration:
            job.progress = round(job.resume_from / job.audio_duration, 3)
        log(f"{job.vid}: loaded partial result, resume at {job.resume_from:.0f}s")
