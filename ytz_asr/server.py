"""HTTP surface.

JSON API for the userscript (/transcript, /translate, /status) and an htmx
dashboard at /. CORS is open but the socket only listens on loopback.
"""

import json
import os
import threading
import time
import traceback
from pathlib import Path
from typing import Annotated, Any

import uvicorn
from fastapi import Body, FastAPI, HTTPException, Path as PathParam, Query
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import Config, Json, log
from . import asr, dashboard, history, translate
from .jobs import JobStore

_MAX_LINES = 2000
_VID = r"^[A-Za-z0-9_-]{11}$"

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


def _cache_info() -> Json:
    files = list(_cfg.cache.glob("*.json"))
    return {
        "audio_mb": round(asr.audio_bytes(_cfg) / 1e6, 1),
        "audio_limit_mb": round(_cfg.audio_max_bytes / 1e6),
        "audio_files": asr.audio_files(_cfg),
        "transcripts": sum(
            1 for p in files if not p.name.endswith(".partial.json") and p.name != "mt_cache.json"
        ),
        "partials": sum(1 for p in files if p.name.endswith(".partial.json")),
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
def delete_transcript(vid: Vid, audio: int = Query(0)) -> Json:
    _jobs.forget(vid, drop_audio=audio == 1)
    return {"deleted": vid}


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


@app.get("/ui/jobs", response_class=HTMLResponse)
def get_jobs_fragment() -> str:
    return dashboard.jobs_list(snapshot())


@app.get("/ui/charts", response_class=HTMLResponse)
def get_charts_fragment() -> str:
    return dashboard.charts(history.series(dashboard.CHART_SAMPLES))


@app.get("/history")
def get_history(limit: int = Query(history.KEEP)) -> Json:
    return history.series(min(limit, history.KEEP))


@app.get("/ui/job/{vid}", response_class=HTMLResponse)
def get_job_fragment(vid: Vid) -> str:
    audio = _cfg.audio / f"{vid}.m4a"
    return dashboard.detail(vid, audio if audio.exists() else None)


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
        translate.cache_flush(cfg)
