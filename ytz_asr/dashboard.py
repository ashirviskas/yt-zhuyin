"""HTML fragments for the dashboard.

The page shell, stylesheet and script are plain files in static/; this module
only renders the bits htmx swaps in. Only the stats block polls — the detail
panel sits outside it so an audio element is never swapped away mid-playback.
"""

import html
import json
import os
import time
from pathlib import Path

from . import Config, Json, Segment

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


# Lucide-style strokes on a 24px grid; inline so the page needs nothing but htmx
_ICONS = {
    "play": '<path d="M7 4.5v15l12-7.5z"/>',
    "stop": '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    "trash": '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
    "eye": '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    "x": '<path d="M18 6 6 18M6 6l12 12"/>',
    "plus": '<path d="M12 5v14M5 12h14"/>',
    "link": '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    "pin": '<path d="M12 17v5M9 3h6l-1 7 4 3v2H6v-2l4-3z"/>',
    "follow": '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
    "lang": '<path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/>',
    "save": '<path d="M5 12l5 5L20 7"/>',
}


def icon(name: str) -> str:
    return (
        '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
        f'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{_ICONS[name]}</svg>'
    )


def _btn(name: str, title: str, attrs: str, kind: str = "") -> str:
    return f'<button class="ib {kind}" title="{title}" aria-label="{title}" {attrs}>{icon(name)}</button>'


def _actions(vid: str, status: str, done: bool) -> str:
    """Icon buttons shared by job cards and library rows. Each POST answers with an
    HX-Trigger that refreshes both lists, so nothing is swapped in place."""
    out = [_btn("eye", "Preview", f'hx-get="/ui/job/{vid}" hx-target="#detail" hx-swap="innerHTML show:#detail:top"')]
    if status in ("queued", "downloading", "transcribing", "translating"):
        out.append(_btn("stop", "Stop (keeps what is transcribed)", f'hx-post="/job/{vid}/stop" hx-swap="none"'))
    elif not done or status == "error":
        verb = "Retry" if status == "error" else "Transcribe" if status == "new" else "Resume"
        out.append(_btn("play", f"{verb} (keeps going without a YouTube tab)",
                        f'hx-post="/job/{vid}/start?force=1" hx-swap="none"', "go"))
    out.append(f'<a class="ib" title="Open on YouTube" aria-label="Open on YouTube" target="_blank" rel="noopener" '
               f'href="https://www.youtube.com/watch?v={vid}">{icon("link")}</a>')
    out.append(_btn("trash", "Delete transcript and audio",
                    f'hx-delete="/transcript/{vid}?audio=1" hx-swap="none" '
                    f'hx-confirm="Delete the transcript, partial and audio for {vid}?"', "danger"))
    return '<span class="acts">' + "".join(out) + "</span>"


def _name(vid: str, title: str | None) -> str:
    v = _esc(vid)
    if title:
        return f'<span class="name"><span class="title">{_esc(title)}</span><code class="vid">{v}</code></span>'
    return f'<span class="name"><code class="vid">{v}</code></span>'


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


def _job(job: Json, title: str | None) -> str:
    status = _esc(job["status"])
    vid = _esc(job["vid"])
    bits: list[str] = [f'{job["segments"]} lines', f'{job["words"]} words']
    if job["audio_duration_sec"]:
        bits.append(f'{_dur(job["transcribed_sec"])} / {_dur(job["audio_duration_sec"])}')
    if job["speed_x"]:
        bits.append(f'{job["speed_x"]}×')
    if job["eta_sec"]:
        bits.append(f'eta {_dur(job["eta_sec"])}')
    if job["status"] not in ("ready", "error", "stopped"):
        bits.append("no tab needed" if job["forced"] else f'lease {_dur(job["lease_expires_in_sec"])}')
    err = f'<div class="err">{_esc(job["error"])}</div>' if job["error"] else ""
    pin = f'<span class="tag" title="Started from the dashboard: runs without a YouTube tab">{icon("pin")}</span>' if job["forced"] else ""
    return f"""<article class="job {status}">
  <div class="row">
    {_name(job["vid"], title)}
    <span class="pill {status}">{status}</span>{pin}
    <span class="spacer"></span>
    {_actions(vid, job["status"], job["status"] == "ready")}
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
        _card("translation", _esc((mt["name"] or "disabled").rsplit("/", 1)[-1]), _loaded_note(mt, f'{mt["cache_entries"]} cached')),
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
    if info.get("inflight") or info.get("busy"):
        return f"in use · {extra}"
    idle, after = info.get("idle_sec"), info.get("unload_after_sec")
    if after and idle is not None:
        return f"loaded · unloads in {_dur(max(0.0, after - idle))} · {extra}"
    return f"loaded · {extra}"


def jobs_list(data: Json, titles: dict[str, str | None]) -> str:
    jobs: list[Json] = data["jobs"]
    if not jobs:
        return ('<h2>Jobs</h2><p class="muted">Nothing running. Paste a video above, press '
                f'{icon("play")} in the library, or open a YouTube video with the userscript.</p>')
    return "<h2>Jobs</h2>" + "".join(_job(j, titles.get(j["vid"])) for j in jobs)


def library(rows: list[Json], titles: dict[str, str | None]) -> str:
    """Everything in the cache dir, newest first, one compact row each."""
    if not rows:
        return '<h2>Library</h2><p class="muted">The cache is empty.</p>'
    out = [f'<h2>Library <span class="muted">{len(rows)}</span></h2><div class="lib">']
    for r in rows:
        vid, status = r["vid"], r["status"]
        kind = "ready" if r["done"] else "partial" if r["partial"] else "audio"
        label = {"ready": "done", "partial": "partial", "audio": "audio only"}[kind]
        live = f'<span class="pill {_esc(status)}">{_esc(status)}</span>' if status not in ("new", "ready") else ""
        audio = f'{r["audio_mb"]:.0f} MB' if r["audio_mb"] else "no audio"
        when = time.strftime("%b %d", time.localtime(r["t"]))
        out.append(f"""<div class="librow">
  {_name(vid, titles.get(vid))}
  <span class="badge {kind}">{label}</span>{live}
  <span class="spacer"></span>
  <span class="num">{audio} · {when}</span>
  {_actions(_esc(vid), status, r["done"])}
</div>""")
    return "".join(out) + "</div>"


# approximate resident size of the int8 weights, per model replica
_MODELS = {"tiny": "~150 MB", "base": "~250 MB", "small": "~500 MB", "medium": "~1.5 GB", "large-v3": "~3 GB"}


def settings(cfg: Config, note: str = "") -> str:
    """The settings form. It lives outside every polling region so typing is never swapped away."""

    def flag(key: str) -> str:
        return f'<span class="flag" title="Passed on the command line: wins again on the next start">--{key.replace("_", "-")}</span>' if key in cfg.flags else ""

    names = dict(_MODELS)
    if cfg.model not in names:
        names[cfg.model] = "custom"
    opts = "".join(
        f'<option value="{_esc(m)}"{" selected" if m == cfg.model else ""}>{_esc(m)} · {ram}</option>'
        for m, ram in names.items()
    )
    cores = os.cpu_count() or 4

    def num(key: str, label: str, lo: float, hi: float, step: float, hint: str) -> str:
        val = getattr(cfg, key)
        return f"""<label class="field"><span class="lbl">{label}{flag(key)}</span>
  <input type="number" name="{key}" value="{val}" min="{lo}" max="{hi}" step="{step}">
  <span class="hint">{hint}</span></label>"""

    def switch(key: str, label: str, hint: str) -> str:
        on = " checked" if getattr(cfg, key) else ""
        return f"""<label class="field sw"><input type="checkbox" name="{key}" value="1"{on}><i></i>
  <span><span class="lbl">{label}{flag(key)}</span><span class="hint">{hint}</span></span></label>"""

    msg = f'<span class="saved">{icon("save")} {_esc(note)}</span>' if note else ""
    return f"""<form class="settings" hx-post="/settings" hx-target="this" hx-swap="outerHTML">
  <div class="grid">
    <label class="field"><span class="lbl">Whisper model{flag("model")}</span>
      <select name="model">{opts}</select>
      <span class="hint">RAM per worker. Swaps when no job is running.</span></label>
    {num("workers", "Workers", 1, cores, 1, f"Videos at once. Each adds a model replica in RAM and splits the {cores} cores.")}
    {num("lease_sec", "Lease (s)", 10, 86400, 1, "Pause a job when no tab polled it for this long.")}
    {num("idle_unload_sec", "Unload after idle (s)", 0, 86400, 1, "Give the weights back to the OS. 0 keeps them loaded.")}
    {num("audio_cache_gb", "Audio cache (GB)", 0, 1000, 0.5, "Downloaded audio kept for previews and resumes.")}
    {switch("live_translate", "Live translation", "Translate lines while a job is still transcribing.")}
    {switch("whisper_translate", "Whisper English pass", "Second full pass after each job. Doubles CPU time.")}
  </div>
  <div class="row"><button class="primary" type="submit">{icon("save")} Save</button>{msg}</div>
</form>"""


def parse_settings(cfg: Config, form: dict[str, str]) -> str:
    """Apply a settings form to cfg in place. Returns what the user should know."""
    before = (cfg.model, cfg.workers)
    model = form.get("model", "").strip()
    if model and all(c.isalnum() or c in "-_./" for c in model):
        cfg.model = model

    def clamp(key: str, lo: float, hi: float) -> None:
        try:
            v = float(form[key])
        except (KeyError, ValueError):
            return
        cur = getattr(cfg, key)
        setattr(cfg, key, type(cur)(min(hi, max(lo, v))))

    clamp("workers", 1, os.cpu_count() or 4)
    clamp("lease_sec", 10, 86400)
    clamp("idle_unload_sec", 0, 86400)
    clamp("audio_cache_gb", 0, 1000)
    cfg.live_translate = form.get("live_translate") == "1"
    cfg.whisper_translate = form.get("whisper_translate") == "1"
    if (cfg.model, cfg.workers) != before:
        return "saved · whisper reloads once no job is running"
    return "saved"


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


def detail(vid: str, title: str | None, audio: Path | None) -> str:
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
  {_name(vid, title)}
  <span class="spacer"></span>
  <span class="acts">
    <label class="ib tog" title="Follow the newest / playing line"><input type="checkbox" id="follow" checked hidden>{icon("follow")}</label>
    <label class="ib tog" title="English under each line"><input type="checkbox" id="show-en" name="en" value="1" hidden>{icon("lang")}</label>
    <button class="ib" title="Close" aria-label="Close" onclick="document.getElementById('detail').innerHTML=''">{icon("x")}</button>
  </span>
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
            f'<p data-t="{seg["start"]:.2f}"><span class="t">{_dur(seg["start"]) if seg["start"] >= 1 else "0s"}</span>'
            f'<span class="txt"><span class="zh">{_esc(seg["text"])}</span>{en}</span></p>'
        )
    return "".join(out)
