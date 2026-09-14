// click a transcript line to seek the preview audio there
document.addEventListener('click', (e) => {
  const line = e.target.closest('[data-t]');
  if (!line) return;
  const audio = document.getElementById('ytz-audio');
  if (!audio) return;
  audio.currentTime = parseFloat(line.dataset.t);
  audio.play();
});
