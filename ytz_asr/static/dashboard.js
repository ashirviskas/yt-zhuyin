// Preview behaviour: click to seek, follow the live tail, highlight the playing line.

const byId = (id) => document.getElementById(id);
const following = () => byId('follow')?.checked;

// click a transcript line to seek the preview audio there
document.addEventListener('click', (e) => {
  const line = e.target.closest('[data-t]');
  if (!line) return;
  const audio = byId('ytz-audio');
  if (!audio) return;
  audio.currentTime = parseFloat(line.dataset.t);
  audio.play();
});

// mark the line the audio is currently inside, and keep it in view while following
function highlight() {
  const audio = byId('ytz-audio'), box = byId('lines');
  if (!audio || !box) return;
  let active = null;
  for (const p of box.querySelectorAll('[data-t]')) {
    if (parseFloat(p.dataset.t) <= audio.currentTime) active = p;
    else break;
  }
  if (!active || active.classList.contains('active')) return;
  box.querySelector('.active')?.classList.remove('active');
  active.classList.add('active');
  if (following()) active.scrollIntoView({ block: 'nearest' });
}

document.body.addEventListener('htmx:afterSwap', (e) => {
  // the player is only rebuilt when the panel itself is replaced
  if (e.target.id === 'detail') byId('ytz-audio')?.addEventListener('timeupdate', highlight);
  if (e.target.id !== 'lines') return;
  const audio = byId('ytz-audio'), box = byId('lines');
  // while nothing is playing, following means sticking to the newest line
  if (following() && (!audio || audio.paused)) box.scrollTop = box.scrollHeight;
  else highlight();
});

// ---- charts: one shared crosshair, Grafana style -------------------------
// Both charts plot the same sample index, so hovering either one reads out the
// memory value and the activity at that timestamp on both.
let hoverIdx = null;

const seriesData = () => {
  const box = document.querySelector('.charts');
  return box ? JSON.parse(box.dataset.series) : null;
};

function showAt(idx) {
  const s = seriesData();
  if (!s || !s.t.length) return;
  idx = Math.max(0, Math.min(s.t.length - 1, idx));
  const frac = s.t.length > 1 ? idx / (s.t.length - 1) : 0;
  for (const svg of document.querySelectorAll('svg.chart')) {
    const x = frac * Number(svg.dataset.w);
    const cross = svg.querySelector('.cross');
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.style.display = '';
  }
  const when = new Date(s.t[idx] * 1000).toLocaleTimeString();
  const running = Object.entries(s.counts)
    .filter(([, series]) => series[idx] > 0)
    .map(([state, series]) => `${series[idx]} ${state}`)
    .join(', ');
  const out = byId('readout');
  if (out) out.textContent = `${when} · ${s.rss[idx].toFixed(0)} MB · ${running || 'idle'}`;
}

function hideCross() {
  hoverIdx = null;
  document.querySelectorAll('svg.chart .cross').forEach((c) => (c.style.display = 'none'));
  const out = byId('readout');
  if (out) out.textContent = 'hover a chart';
}

document.addEventListener('mousemove', (e) => {
  const svg = e.target.closest('svg.chart');
  if (!svg) return;
  const s = seriesData();
  if (!s || !s.t.length) return;
  const box = svg.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
  hoverIdx = Math.round(frac * (s.t.length - 1));
  showAt(hoverIdx);
});

document.addEventListener('mouseout', (e) => {
  if (e.target.closest('.charts') && !e.relatedTarget?.closest('.charts')) hideCross();
});

// the charts redraw every few seconds; put the crosshair back where it was
document.body.addEventListener('htmx:afterSwap', (e) => {
  if (e.target.id === 'charts' && hoverIdx !== null) showAt(hoverIdx);
});
