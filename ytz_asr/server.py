"""HTTP surface: /transcript, /translate, /status. CORS open, bound to loopback only."""

import json
import os
import re
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import Config, Json, log
from . import asr, translate
from .jobs import JobStore

_VID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_TRANSCRIPT = re.compile(r"^/transcript/([^/?]+)")
_MAX_LINES = 2000

_cfg: Config
_jobs: JobStore
_started_at = time.time()


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
    results = sorted(_cfg.cache.glob("*.json"))
    return {
        "audio_mb": round(asr.audio_bytes(_cfg) / 1e6, 1),
        "audio_limit_mb": round(_cfg.audio_max_bytes / 1e6),
        "audio_files": asr.audio_files(_cfg),
        "transcripts": sum(1 for p in results if not p.name.endswith(".partial.json") and p.name != "mt_cache.json"),
        "partials": sum(1 for p in results if p.name.endswith(".partial.json")),
        "dir": str(_cfg.cache),
    }


def status() -> Json:
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


# ---- handler ------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = "ytz-asr"

    def _send(self, code: int, obj: Json, pretty: bool = False) -> None:
        body = json.dumps(obj, ensure_ascii=False, indent=2 if pretty else None).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        _ = self.wfile.write(body)

    def _vid(self) -> str | None:
        m = _TRANSCRIPT.match(self.path)
        return m.group(1) if m and _VID.match(m.group(1)) else None

    def do_OPTIONS(self) -> None:
        self._send(204, {})

    def do_GET(self) -> None:
        if self.path.startswith("/status"):
            return self._send(200, status(), pretty="pretty=1" in self.path)
        vid = self._vid()
        if vid is None:
            return self._send(404, {"error": "not found"})
        return self._send(200, _jobs.request(vid))

    def do_POST(self) -> None:
        if not self.path.startswith("/translate"):
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            payload: Json = json.loads(self.rfile.read(n) or b"{}")
            lines = payload.get("lines", [])
            if not isinstance(lines, list) or len(lines) > _MAX_LINES:
                return self._send(400, {"error": f"lines must be a list (max {_MAX_LINES})"})
            t0 = time.time()
            out = translate.translate(_cfg, [str(x) for x in lines])
            log(f"translated {len(lines)} lines in {time.time() - t0:.1f}s")
            return self._send(200, {"lines": out})
        except Exception as e:
            traceback.print_exc()
            return self._send(500, {"error": str(e)})

    def do_DELETE(self) -> None:
        vid = self._vid()
        if vid is None:
            return self._send(404, {"error": "not found"})
        _jobs.forget(vid, drop_audio="audio=1" in self.path)
        return self._send(200, {"deleted": vid})

    def log_message(self, format: str, *args: object) -> None:
        first = str(args[0]) if args else ""
        if "/status" not in first:  # polling a dashboard shouldn't spam the log
            log(self.address_string(), format % args)


def serve(cfg: Config, jobs: JobStore) -> None:
    global _cfg, _jobs
    _cfg, _jobs = cfg, jobs
    srv = ThreadingHTTPServer(("127.0.0.1", cfg.port), Handler)
    log(f"listening on http://127.0.0.1:{cfg.port}  cache: {cfg.cache}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        translate.cache_flush(cfg)
