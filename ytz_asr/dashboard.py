"""HTML fragments for the dashboard.

The page shell, stylesheet and script are plain files in static/; this module
only renders the bits htmx swaps in. Only the stats block polls — the detail
panel sits outside it so an audio element is never swapped away mid-playback.
"""

import html
from pathlib import Path

from . import Json, Segment

STATIC = Path(__file__).parent / "static"
PREVIEW_LINES = 300


def _dur(sec: float | None) -> str:
    if not sec:
        return "—"
    sec = int(sec)
    h, m, s = sec // 3600, sec % 3600 // 60, sec % 60
    if h:
        return f"{h}h{m:02d}m"
    return f"{m}:{s:02d}" if m else f"{s}s"


def _esc(v: object) -> str:
    return html.escape(str(v))


def _card(key: str, value: str, sub: str = "") -> str:
    tail = f'<div class="s">{sub}</div>' if sub else ""
    return f'<div class="card"><div class="k">{key}</div><div class="v">{value}</div>{tail}</div>'


def _bar(fraction: float, kind: str = "") -> str:
    pct = max(0.0, min(1.0, fraction)) * 100
    return f'<div class="bar {kind}"><i style="width:{pct:.1f}%"></i></div>'


def _job(job: Json) -> str:
    status = _esc(job["status"])
    vid = _esc(job["vid"])
    bits: list[str] = [f'{job["segments"]} lines', f'{job["words"]} words']
    if job["audio_duration_sec"]:
        bits.append(f'{_dur(job["transcribed_sec"])} / {_dur(job["audio_duration_sec"])}')
    if job["speed_x"]:
        bits.append(f'{job["speed_x"]}×')
    if job["eta_sec"]:
        bits.append(f'eta {_dur(job["eta_sec"])}')
    bits.append(f'lease {_dur(job["lease_expires_in_sec"])}')
    err = f'<div class="err">{_esc(job["error"])}</div>' if job["error"] else ""
    return f"""<article class="job {status}">
  <div class="row">
    <code class="vid">{vid}</code>
    <span class="pill {status}">{status}</span>
    <span class="spacer"></span>
    <button hx-get="/ui/job/{vid}" hx-target="#detail" hx-swap="innerHTML">preview</button>
  </div>
  {_bar(float(job["progress"]))}
  <div class="meta">{' · '.join(bits)}</div>{err}
</article>"""


def stats(data: Json) -> str:
    server: Json = data["server"]
    model: Json = data["model"]
    mt: Json = data["mt"]
    mem: Json = data["memory"]
    cache: Json = data["cache"]
    jobs: list[Json] = data["jobs"]
    queue: list[str] = data["queue"]

    rss = mem["rss_mb"] or 0
    total = mem["system_total_mb"] or 0
    cards = "".join([
        _card("model", _esc(model["name"]),
              "loaded · cpu int8" if model["loaded"] else "not loaded"),
        _card("uptime", _dur(server["uptime_sec"]), f'pid {server["pid"]} · port {server["port"]}'),
        _card("memory", f"{rss:.0f} MB",
              f'peak {mem["peak_rss_mb"] or 0:.0f} MB of {total / 1024:.1f} GB'
              + _bar(rss / total if total else 0, "mem")),
        _card("translation", "ready" if mt["loaded"] else ("idle" if mt["name"] else "disabled"),
              f'{mt["cache_entries"]} cached · {mt["unsaved"]} unsaved'),
        _card("audio cache", f'{cache["audio_mb"]:.0f} MB',
              f'{cache["audio_files"]} files of {cache["audio_limit_mb"]} MB limit'
              + _bar(cache["audio_mb"] / cache["audio_limit_mb"] if cache["audio_limit_mb"] else 0, "disk")),
        _card("transcripts", str(cache["transcripts"]),
              f'{cache["partials"]} partial · {len(queue)} queued'),
    ])

    if jobs:
        body = "".join(_job(j) for j in jobs)
    else:
        body = '<p class="muted">No jobs. Open a YouTube video with the userscript active, or hit /transcript/&lt;videoId&gt;.</p>'
    return f'<div class="cards">{cards}</div><h2>Jobs</h2>{body}'


def detail(vid: str, segs: list[Segment], total: int, tail: bool, audio: Path | None) -> str:
    head = f'<div class="row"><code class="vid">{_esc(vid)}</code>'
    head += f'<span class="spacer"></span><button onclick="document.getElementById(\'detail\').innerHTML=\'\'">close</button></div>'
    player = (
        f'<audio id="ytz-audio" controls preload="metadata" src="/audio/{_esc(vid)}"></audio>'
        if audio
        else '<p class="muted">No cached audio for this video.</p>'
    )
    if segs:
        shown = f"last {len(segs)} of {total}" if tail else f"first {len(segs)} of {total}"
        label = f'<div class="meta">{shown} lines · click a line to seek</div>'
        lines = "".join(
            f'<p data-t="{s["start"]:.2f}"><span class="t">{_dur(s["start"])}</span>'
            f'<span class="zh">{_esc(s["text"])}</span></p>'
            for s in segs
        )
        body = f'{label}<div class="lines">{lines}</div>'
    else:
        body = '<p class="muted">No transcript lines yet.</p>'
    return f"{head}{player}{body}"
