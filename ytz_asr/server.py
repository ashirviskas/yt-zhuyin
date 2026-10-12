"""HTTP surface.

JSON API for the userscript (/transcript, /translate, /status) and an htmx
dashboard at /. CORS is open but the socket only listens on loopback.
"""

import json
import os
import re
import threading
import time
import traceback
from pathlib import Path
from typing import Annotated, Any

import uvicorn
from urllib.parse import parse_qs

from fastapi import Body, FastAPI, HTTPException, Path as PathParam, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import SETTINGS, Config, Json, log
from . import asr, dashboard, history, titles, translate
from .jobs import JobStore

_MAX_LINES = 2000
_VID = r"^[A-Za-z0-9_-]{11}$"
# a bare id, or any youtube.com / youtu.be URL carrying one
_VID_IN = re.compile(r"(?:v=|youtu\.be/|shorts/|live/|embed/)([A-Za-z0-9_-]{11})|^([A-Za-z0-9_-]{11})$")
_REFRESH = {"HX-Trigger": "ytz-refresh"}  # tells the job list and the library to reload now

_cfg: Config
_jobs: JobStore
_started_at = time.time()

app = FastAPI(title="yt-zhuyin ASR", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

type Vid = Annotated[str, PathParam(pattern=_VID)]


# ---- memory (Linux /proc; this is where the service runs) ---------------


def _proc_kb(path: Path, *keys: str) -> dict[str, int]:
    found: dict[str, int] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            name, _, rest = line.partition(":")
            if name in keys:
                found[name] = int(rest.split()[0])
    except (OSError, ValueError, IndexError):
        pass
    return found


def _memory() -> Json:
    mine = _proc_kb(Path("/proc/self/status"), "VmRSS", "VmHWM")
    system = _proc_kb(Path("/proc/meminfo"), "MemTotal", "MemAvailable")

    def mb(source: dict[str, int], key: str) -> float | None:
        return round(source[key] / 1024, 1) if key in source else None

    return {
        "rss_mb": mb(mine, "VmRSS"),
        "peak_rss_mb": mb(mine, "VmHWM"),
        "system_total_mb": mb(system, "MemTotal"),
        "system_available_mb": mb(system, "MemAvailable"),
    }


def _library() -> list[Json]:
    """One row per video id in the cache dir, from file names and stat() alone."""
    rows: dict[str, Json] = {}

    def row(vid: str, mtime: float) -> Json:
        r = rows.setdefault(vid, {"vid": vid, "done": False, "partial": False, "audio_mb": 0.0, "t": 0.0})
        r["t"] = max(r["t"], mtime)
        return r

    for p in _cfg.cache.glob("*.json"):
        partial = p.name.endswith(".partial.json")
        vid = p.name.removesuffix(".partial.json") if partial else p.stem
        if re.match(_VID, vid):  # skips mt_cache.json, settings.json, titles.json
            row(vid, p.stat().st_mtime)["partial" if partial else "done"] = True
    for p in _cfg.audio.glob("*.m4a"):
        if re.match(_VID, p.stem):
            st = p.stat()
            row(p.stem, st.st_mtime)["audio_mb"] = st.st_size / 1e6
    states = _jobs.states()
    for r in rows.values():
        r["status"] = states.get(r["vid"], "ready" if r["done"] else "new")
    return sorted(rows.values(), key=lambda r: r["t"], reverse=True)


def _cache_info() -> Json:
    rows = _library()
    return {
        "audio_mb": round(asr.audio_bytes(_cfg) / 1e6, 1),
        "audio_limit_mb": round(_cfg.audio_max_bytes / 1e6),
        "audio_files": asr.audio_files(_cfg),
        "transcripts": sum(1 for r in rows if r["done"]),
        "partials": sum(1 for r in rows if r["partial"] and not r["done"]),
        "dir": str(_cfg.cache),
    }


def snapshot() -> Json:
    jobs, queue, totals = _jobs.report()
    return {
        "server": {
            "pid": os.getpid(),
            "uptime_sec": round(time.time() - _started_at, 1),
            "port": _cfg.port,
            "lease_sec": _cfg.lease_sec,
        },
        "model": asr.info(_cfg),
        "mt": translate.info(_cfg),
        "memory": _memory(),
        "jobs": jobs,
        "queue": queue,
        "totals": totals,
        "cache": _cache_info(),
    }


# ---- JSON API (the userscript depends on these payloads) ----------------


@app.get("/transcript/{vid}")
def get_transcript(vid: Vid) -> Json:
    return _jobs.request(vid)


@app.delete("/transcript/{vid}")
def delete_transcript(vid: Vid, audio: int = Query(0)) -> JSONResponse:
    _jobs.forget(vid, drop_audio=audio == 1)
    return JSONResponse({"deleted": vid}, headers=_REFRESH)


@app.post("/job/{vid}/start")
def post_start(vid: Vid, force: int = Query(0)) -> JSONResponse:
    """Start or resume. force=1 (the dashboard) keeps it running without a polling tab."""
    _jobs.start(vid, force=force == 1)
    return JSONResponse({"started": vid}, headers=_REFRESH)


@app.post("/job/{vid}/stop")
def post_stop(vid: Vid) -> JSONResponse:
    """Pause after the current segment, keep the partial, don't auto-resume on the next poll."""
    _jobs.stop(vid)
    return JSONResponse({"stopped": vid}, headers=_REFRESH)


async def _form(request: Request) -> dict[str, str]:
    """A urlencoded form body, without pulling in python-multipart for two forms."""
    body = (await request.body()).decode("utf-8", "replace")
    return {k: v[-1] for k, v in parse_qs(body).items()}


@app.post("/jobs", response_class=HTMLResponse)
async def post_jobs(request: Request) -> HTMLResponse:
    """The dashboard's add-video box: an id or any YouTube URL."""
    text = (await _form(request)).get("video", "").strip()
    m = _VID_IN.search(text)
    if not m:
        return HTMLResponse('<span class="err">not a video id or YouTube URL</span>')
    vid = m.group(1) or m.group(2)
    _jobs.start(vid, force=True)
    return HTMLResponse(f'<span class="ok">queued {vid}</span>', headers=_REFRESH)


@app.post("/translate")
def post_translate(payload: Annotated[dict[str, Any], Body()]) -> Json:
    lines = payload.get("lines", [])
    if not isinstance(lines, list) or len(lines) > _MAX_LINES:
        raise HTTPException(400, f"lines must be a list (max {_MAX_LINES})")
    t0 = time.time()
    try:
        out = translate.translate(_cfg, [str(x) for x in lines])
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, str(e)) from e
    log(f"translated {len(lines)} lines in {time.time() - t0:.1f}s")
    return {"lines": out}


@app.get("/status")
def get_status(pretty: int = Query(0)) -> Response:
    data = snapshot()
    if pretty:
        text = json.dumps(data, ensure_ascii=False, indent=2)
        return Response(text, media_type="application/json; charset=utf-8")
    return JSONResponse(data)


# ---- dashboard ----------------------------------------------------------


app.mount("/static", StaticFiles(directory=dashboard.STATIC), name="static")


@app.get("/", response_class=HTMLResponse)
def get_page() -> FileResponse:
    """The page shell is a plain file; only the fragments below are generated."""
    return FileResponse(dashboard.STATIC / "index.html", media_type="text/html")


@app.get("/ui/cards", response_class=HTMLResponse)
def get_cards_fragment() -> str:
    return dashboard.cards(snapshot())


def _titles(vids: list[str]) -> dict[str, str | None]:
    return {v: titles.get(_cfg, v) for v in vids}


@app.get("/ui/jobs", response_class=HTMLResponse)
def get_jobs_fragment() -> str:
    data = snapshot()
    return dashboard.jobs_list(data, _titles([j["vid"] for j in data["jobs"]]))


@app.get("/ui/library", response_class=HTMLResponse)
def get_library_fragment() -> str:
    rows = _library()
    return dashboard.library(rows, _titles([r["vid"] for r in rows]))


@app.get("/ui/settings", response_class=HTMLResponse)
def get_settings_fragment() -> str:
    return dashboard.settings(_cfg)


@app.post("/settings", response_class=HTMLResponse)
async def post_settings(request: Request) -> HTMLResponse:
    workers, audio = _cfg.workers, _cfg.audio_cache_gb
    note = dashboard.parse_settings(_cfg, await _form(request))
    _cfg.save_settings()
    if _cfg.workers != workers:
        asr.ensure_workers(_cfg, _jobs)
    if _cfg.audio_cache_gb < audio:
        asr.evict_audio(_cfg)
    log("settings:", {k: getattr(_cfg, k) for k in SETTINGS})
    return HTMLResponse(dashboard.settings(_cfg, note), headers=_REFRESH)


@app.get("/ui/charts", response_class=HTMLResponse)
def get_charts_fragment() -> str:
    return dashboard.charts(history.series(dashboard.CHART_SAMPLES))


@app.get("/history")
def get_history(limit: int = Query(history.KEEP)) -> Json:
    return history.series(min(limit, history.KEEP))


@app.get("/ui/job/{vid}", response_class=HTMLResponse)
def get_job_fragment(vid: Vid) -> str:
    audio = _cfg.audio / f"{vid}.m4a"
    return dashboard.detail(vid, titles.get(_cfg, vid), audio if audio.exists() else None)


@app.get("/ui/lines/{vid}", response_class=HTMLResponse)
def get_lines_fragment(vid: Vid, en: int = Query(0)) -> str:
    segs, total, live = _jobs.preview(vid, dashboard.PREVIEW_LINES)
    english = (
        translate.preview(_cfg, [s["text"] for s in segs], dashboard.TRANSLATE_PER_POLL)
        if en and segs
        else None
    )
    return dashboard.lines(segs, total, live, english)


@app.get("/audio/{vid}")
def get_audio(vid: Vid) -> FileResponse:
    """Served through FileResponse so the browser can range-request and seek."""
    path = _cfg.audio / f"{vid}.m4a"
    if not path.exists():
        raise HTTPException(404, "no cached audio")
    return FileResponse(path, media_type="audio/mp4")


def reading() -> history.Reading:
    """One history sample: resident memory, what the jobs are doing, whether MT is running."""
    _, _, totals = _jobs.report()
    return (_memory()["rss_mb"] or 0.0, totals, translate.busy())


def serve(cfg: Config, jobs: JobStore) -> None:
    global _cfg, _jobs
    _cfg, _jobs = cfg, jobs
    # started here, not in main(): reading() needs the globals above to be set
    threading.Thread(target=history.sampler, args=(reading,), daemon=True).start()
    log(f"listening on http://127.0.0.1:{cfg.port}  dashboard: http://127.0.0.1:{cfg.port}/")
    log(f"cache: {cfg.cache}")
    try:
        uvicorn.run(app, host="127.0.0.1", port=cfg.port, log_level="warning", access_log=False)
    except KeyboardInterrupt:
        pass
    finally:
        jobs.checkpoint_all()
        translate.cache_flush(cfg)
