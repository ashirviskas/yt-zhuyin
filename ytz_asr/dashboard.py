"""HTML fragments for the dashboard.

The page shell, stylesheet and script are plain files in static/; this module
only renders the bits htmx swaps in. Only the stats block polls — the detail
panel sits outside it so an audio element is never swapped away mid-playback.
"""

import html
import json
from pathlib import Path

from . import Json, Segment

STATIC = Path(__file__).parent / "static"
PREVIEW_LINES = 300
TRANSLATE_PER_POLL = 12   # new lines translated per dashboard poll; the rest catch up later
CHART_W, MEM_H, STATE_H = 640, 110, 74
CHART_SAMPLES = 300       # ~10 minutes at the sampler's 2s cadence

_ACT = {            # stacking order, bottom to top
    "transcribing": "#e8b339",
    "downloading": "#a78bfa",
    "queued": "#4b5563",
    "translating": "#60a5fa",
}


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


def cards(data: Json) -> str:
    server: Json = data["server"]
    model: Json = data["model"]
    mt: Json = data["mt"]
    mem: Json = data["memory"]
    cache: Json = data["cache"]

    rss = mem["rss_mb"] or 0
    total = mem["system_total_mb"] or 0
    return '<div class="cards">' + "".join([
        _card("model", _esc(model["name"]), _loaded_note(model, "cpu int8")),
        _card("uptime", _dur(server["uptime_sec"]), f'pid {server["pid"]} · port {server["port"]}'),
        _card("memory", f"{rss:.0f} MB",
              f'peak {mem["peak_rss_mb"] or 0:.0f} MB of {total / 1024:.1f} GB'
              + _bar(rss / total if total else 0, "mem")),
        _card("translation", _esc(mt["name"] or "disabled"), _loaded_note(mt, f'{mt["cache_entries"]} cached')),
        _card("audio cache", f'{cache["audio_mb"]:.0f} MB',
              f'{cache["audio_files"]} files of {cache["audio_limit_mb"]} MB limit'
              + _bar(cache["audio_mb"] / cache["audio_limit_mb"] if cache["audio_limit_mb"] else 0, "disk")),
        _card("transcripts", str(cache["transcripts"]),
              f'{cache["partials"]} partial · {len(data["queue"])} queued'),
    ]) + "</div>"


def _loaded_note(info: Json, extra: str) -> str:
    """Whether the weights are in memory, and how long until they are dropped."""
    if not info.get("name"):
        return "disabled"
    if not info["loaded"]:
        return f"not loaded · {extra}"
    idle, after = info.get("idle_sec"), info.get("unload_after_sec")
    if after and idle is not None:
        return f"loaded · unloads in {_dur(max(0.0, after - idle))} · {extra}"
    return f"loaded · {extra}"


def jobs_list(data: Json) -> str:
    jobs: list[Json] = data["jobs"]
    if not jobs:
        return '<h2>Jobs</h2><p class="muted">No jobs. Open a YouTube video with the userscript active, or hit /transcript/&lt;videoId&gt;.</p>'
    return "<h2>Jobs</h2>" + "".join(_job(j) for j in jobs)


def charts(data: Json) -> str:
    """Memory over time above a stacked count of what was running, sharing one readout."""
    ts: list[float] = data["t"]
    rss: list[float] = data["rss_mb"]
    counts: dict[str, list[int]] = data["counts"]
    n = len(ts)
    if n < 2:
        return '<h2>History</h2><p class="muted">collecting samples…</p>'

    def x(i: int) -> float:
        return i / (n - 1) * CHART_W

    # memory
    lo, hi = min(rss), max(rss)
    span = (hi - lo) or 1.0
    mem_line = " ".join(
        f"{x(i):.1f},{MEM_H - 6 - (v - lo) / span * (MEM_H - 18):.1f}" for i, v in enumerate(rss)
    )
    mem_area = f"0,{MEM_H} {mem_line} {CHART_W},{MEM_H}"

    # state counts, stacked
    peak = max(1, max(sum(counts[s][i] for s in _ACT) for i in range(n)))

    def y(v: float) -> float:
        return STATE_H - 3 - (v / peak) * (STATE_H - 10)

    floor = [0.0] * n
    bands: list[str] = []
    for state, colour in _ACT.items():
        if not any(counts[state]):
            continue
        below = list(floor)
        for i in range(n):
            floor[i] += counts[state][i]
        top = " ".join(f"{x(i):.1f},{y(floor[i]):.1f}" for i in range(n))
        bottom = " ".join(f"{x(i):.1f},{y(below[i]):.1f}" for i in reversed(range(n)))
        bands.append(f'<polygon points="{top} {bottom}" fill="{colour}" opacity=".85"/>')
    if not bands:
        bands.append(f'<line x1="0" y1="{y(0):.1f}" x2="{CHART_W}" y2="{y(0):.1f}" stroke="#2a2a2a"/>')

    legend = "".join(
        f'<span class="lg"><i style="background:{v}"></i>{k}</span>' for k, v in _ACT.items()
    )
    payload = html.escape(json.dumps({"t": ts, "rss": rss, "counts": counts}), quote=True)
    return f"""<h2>History <span class="muted">last {(ts[-1] - ts[0]) / 60:.0f} min</span></h2>
<div class="charts" data-series="{payload}">
  <div class="chartrow">
    <div class="ylab">{hi:.0f}<span>{lo:.0f} MB</span></div>
    <svg class="chart mem" data-w="{CHART_W}" viewBox="0 0 {CHART_W} {MEM_H}" preserveAspectRatio="none">
      <polygon points="{mem_area}" fill="rgba(96,165,250,.14)"/>
      <polyline points="{mem_line}" fill="none" stroke="#60a5fa" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
      <line class="cross" y1="0" y2="{MEM_H}" stroke="#e8b339" vector-effect="non-scaling-stroke" style="display:none"/>
    </svg>
  </div>
  <div class="chartrow">
    <div class="ylab">{peak}<span>running</span></div>
    <svg class="chart band" data-w="{CHART_W}" viewBox="0 0 {CHART_W} {STATE_H}" preserveAspectRatio="none">
      {"".join(bands)}
      <line class="cross" y1="0" y2="{STATE_H}" stroke="#e8b339" vector-effect="non-scaling-stroke" style="display:none"/>
    </svg>
  </div>
  <div class="foot"><div class="readout" id="readout">hover a chart</div><div class="legend">{legend}</div></div>
</div>"""


def detail(vid: str, audio: Path | None) -> str:
    """The stable half of the preview: controls and the player.

    The lines below poll on their own so this audio element is never swapped
    away mid-playback.
    """
    v = _esc(vid)
    player = (
        f'<audio id="ytz-audio" controls preload="metadata" src="/audio/{v}"></audio>'
        if audio
        else '<p class="muted">No cached audio for this video.</p>'
    )
    return f"""<div class="row">
  <code class="vid">{v}</code>
  <span class="spacer"></span>
  <label class="chk"><input type="checkbox" id="follow" checked> follow</label>
  <label class="chk"><input type="checkbox" id="show-en" name="en" value="1"> English</label>
  <button onclick="document.getElementById('detail').innerHTML=''">close</button>
</div>
{player}
<div id="lines" class="lines"
     hx-get="/ui/lines/{v}" hx-trigger="load, every 2s, change from:#show-en"
     hx-include="#show-en" hx-sync="this:drop" hx-swap="innerHTML">
  <p class="muted">loading…</p>
</div>"""


def lines(segs: list[Segment], total: int, live: bool, english: list[str] | None) -> str:
    """The polled half: the transcript itself, optionally with English under each line."""
    if not segs:
        return '<p class="muted">No transcript lines yet.</p>'
    window = f"last {len(segs)} of {total}" if live else f"first {len(segs)} of {total}"
    note = "following" if live else "click a line to seek"
    out = [f'<div class="meta">{window} lines · {note}</div>']
    for i, seg in enumerate(segs):
        en = ""
        if english:
            text = english[i] if i < len(english) else ""
            en = f'<span class="en">{_esc(text)}</span>' if text else '<span class="en pending">…</span>'
        out.append(
            f'<p data-t="{seg["start"]:.2f}"><span class="t">{_dur(seg["start"])}</span>'
            f'<span class="txt"><span class="zh">{_esc(seg["text"])}</span>{en}</span></p>'
        )
    return "".join(out)
