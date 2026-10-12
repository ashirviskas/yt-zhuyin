  // ---------------------------------------------------------------- icons
  // Lucide-style strokes on a 24px grid. Built with createElementNS because YouTube
  // enforces Trusted Types: innerHTML with a plain string throws there.
  const ring = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
  const FRAME = 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z';
  const ICONS = {
    refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
    trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
    stop: 'M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
    play: 'M7 4.5v15l12-7.5z',
    follow: ring(12, 12, 3) + 'M12 2v4M12 18v4M2 12h4M18 12h4',
    lang: 'm5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6',
    pinyin: 'M6 3h12' + ring(11, 14.5, 5.5) + 'M16.5 9v11',                   // ā
    zyTop: 'M6 4h12M5 9h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z',   // reading above the character
    byLine: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    width: 'M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4',
    alpha: 'M12 2.7 6.3 8.4a8 8 0 1 0 11.4 0z',
    side: FRAME + 'M15 3v18',
    below: FRAME + 'M3 15h18',
    overlay: FRAME + 'M13 12h5v5h-5z',
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor',
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', ICONS[name]); svg.appendChild(p);
    return svg;
  }
  function iconBtn(name, title, onclick) {
    const b = document.createElement('button'); b.className = 'ytz-ib'; b.title = title; b.setAttribute('aria-label', title);
    b.appendChild(icon(name)); b.onclick = onclick; return b;
  }
  // pressed state lives in aria-pressed, which the CSS also styles
  function toggleBtn(name, title, on, onchange) {
    const b = iconBtn(name, title, () => { const v = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', v); onchange(v); });
    b.setAttribute('aria-pressed', !!on); return b;
  }
  const group = (...els) => { const g = document.createElement('span'); g.className = 'ytz-grp-i'; g.append(...els.filter(Boolean)); return g; };
