"""Job bookkeeping: the in-flight videos, the queue, and the one lock guarding both."""

import json
import threading
import time
from dataclasses import dataclass, field

from . import Config, Json, JobStatus, Segment, log


@dataclass(slots=True)
class Job:
    """One video being transcribed. `words` feed the userscript's re-chunker."""

    vid: str
    status: JobStatus = "queued"
    segs: list[Segment] = field(default_factory=list)
    words: list[Segment] = field(default_factory=list)
    en: list[Segment] | None = None
    done: bool = False
    progress: float = 0.0
    resume_from: float = 0.0
    audio_duration: float = 0.0
    created_at: float = field(default_factory=time.time)
    started_at: float = 0.0
    last_seen: float = field(default_factory=time.time)
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
            "segments": len(self.segs),
            "words": len(self.words),
            "audio_duration_sec": round(self.audio_duration, 1) or None,
            "transcribed_sec": round(self.resume_from, 1),
            "elapsed_sec": round(elapsed, 1) if elapsed else None,
            "speed_x": round(speed, 2) if speed else None,
            "eta_sec": round(eta) if eta else None,
            "age_sec": round(now - self.created_at, 1),
            "last_seen_sec_ago": round(idle, 1),
            "lease_expires_in_sec": round(max(0.0, lease_sec - idle), 1),
            "error": self.error,
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
        """Start the job, or heartbeat it and report progress. Resumes a paused one."""
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
        now = time.time()
        with self._cv:
            job = self._jobs.get(vid)
            if job is None:
                job = self._jobs[vid] = Job(vid=vid)
                self._load_partial(job)
                enqueue = True
            else:
                job.last_seen = now
                enqueue = job.status == "paused"
                if enqueue:
                    job.status = "queued"
            if enqueue and vid not in self._queue:
                self._queue.append(vid)
                self._cv.notify()
            return job.client_view()

    def forget(self, vid: str, drop_audio: bool) -> None:
        self._cfg.result(vid).unlink(missing_ok=True)
        self._cfg.partial(vid).unlink(missing_ok=True)
        if drop_audio:
            (self._cfg.audio / f"{vid}.m4a").unlink(missing_ok=True)
        with self._cv:
            _ = self._jobs.pop(vid, None)

    # ---- worker side ----------------------------------------------------

    def next_vid(self) -> str:
        with self._cv:
            while not self._queue:
                self._cv.wait()
            return self._queue.pop(0)

    def mark(self, vid: str, status: JobStatus) -> None:
        with self._cv:
            self._jobs[vid].status = status

    def begin(self, vid: str, duration: float) -> None:
        with self._cv:
            job = self._jobs[vid]
            job.started_at = time.time()
            job.audio_duration = duration

    def snapshot_progress(self, vid: str) -> tuple[list[Segment], list[Segment], float]:
        with self._cv:
            job = self._jobs[vid]
            return list(job.segs), list(job.words), job.resume_from

    def record(self, vid: str, segs: list[Segment], words: list[Segment], end: float, duration: float) -> None:
        with self._cv:
            job = self._jobs[vid]
            job.segs = list(segs)
            job.words = list(words)
            job.resume_from = end
            job.progress = round(end / duration, 3) if duration else 0.0

    def finish(self, vid: str, segs: list[Segment], words: list[Segment], en: list[Segment] | None, model: str) -> None:
        result: Json = {"vid": vid, "segs": segs, "words": words, "en": en, "model": model, "t": time.time()}
        _ = self._cfg.result(vid).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        self._cfg.partial(vid).unlink(missing_ok=True)
        with self._cv:
            job = self._jobs[vid]
            job.segs, job.words, job.en = segs, words, en
            job.status, job.done, job.progress = "ready", True, 1.0

    def fail(self, vid: str, message: str) -> None:
        with self._cv:
            job = self._jobs[vid]
            job.status, job.error, job.done = "error", message, True

    def pause(self, vid: str) -> None:
        """Stop work and keep what we have; the next poll resumes from here."""
        with self._cv:
            job = self._jobs[vid]
            job.status = "paused"
            data: Json = {
                "vid": vid,
                "segs": job.segs,
                "words": job.words,
                "resume_from": job.resume_from,
                "t": time.time(),
            }
        _ = self._cfg.partial(vid).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def lease_expired(self, vid: str) -> bool:
        with self._cv:
            return time.time() - self._jobs[vid].last_seen > self._cfg.lease_sec

    def preview(self, vid: str, limit: int) -> tuple[list[Segment], int, bool]:
        """Lines for the dashboard. A live job shows its tail, a finished one its start."""
        with self._cv:
            job = self._jobs.get(vid)
            segs = list(job.segs) if job else []
            live = bool(job) and not job.done
        if not segs:
            path = self._cfg.result(vid)
            if path.exists():
                try:
                    d: Json = json.loads(path.read_text(encoding="utf-8"))
                    segs = d.get("segs") or []
                    live = False
                except (OSError, ValueError) as e:
                    log("bad result file:", e)
        total = len(segs)
        window = segs[-limit:] if live else segs[:limit]
        return window, total, live

    # ---- status ---------------------------------------------------------

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

    # ---- internals ------------------------------------------------------

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
        log(f"{job.vid}: loaded partial result, resume at {job.resume_from:.0f}s")
