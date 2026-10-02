import './app.js';
// Small controls stay separate from the image/score lifecycle.
const $ = id => document.getElementById(id);
$('uploadTrigger').addEventListener('click', () => $('uploadInput').click());
const engine = window.__gl?.engine;
if (engine) {
  const volume = $('volumeSlider');
  const mute = $('muteBtn');
  let muted = false;
  engine.setVolume?.(Number(volume.value) / 100);
  volume.addEventListener('input', () => {
    engine.setVolume?.(Number(volume.value) / 100);
    if (muted && Number(volume.value) > 0) { muted = false; engine.setMuted?.(false); }
    updateMute();
  });
  function updateMute() {
    mute.setAttribute('aria-pressed', String(muted));
    mute.setAttribute('aria-label', muted ? '取消静音' : '静音');
    mute.title = muted ? '取消静音' : '静音';
  }
  mute.addEventListener('click', () => { muted = !muted; engine.setMuted?.(muted); updateMute(); });
  document.querySelectorAll('[data-track]').forEach(button => {
    button.addEventListener('click', () => {
      const enabled = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', String(enabled));
      button.classList.toggle('active', enabled);
      engine.setTrackEnabled?.(button.dataset.track, enabled);
    });
  });
  engine.onNotice = ({ message, kind }) => {
    $('status').textContent = message;
    $('status').className = `status ${kind === 'error' ? 'err' : ''}`;
  };
}
