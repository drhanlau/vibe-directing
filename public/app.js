const $ = (id) => document.getElementById(id);

const el = {
  screen: $('screen'), player: $('player'), still: $('stillFrame'),
  busy: $('screenBusy'), busyLabel: $('busyLabel'), nowPlaying: $('nowPlaying'),
  headMeta: $('headMeta'), playBtn: $('playBtn'), restartBtn: $('restartBtn'),
  downloadBtn: $('downloadBtn'), downloadError: $('downloadError'),
  reel: $('reel'), autoplayNew: $('autoplayNew'),
  drop: $('drop'), fileInput: $('fileInput'), startThumb: $('startThumb'),
  openingNote: $('openingNote'), beats: $('beats'), storyScroll: $('storyScroll'),
  composer: $('composer'), composerError: $('composerError'),
  lineInput: $('lineInput'), speakerInput: $('speakerInput'),
  directionInput: $('directionInput'), continuityChk: $('continuityChk'),
  durationSel: $('durationSel'), resolutionSel: $('resolutionSel'),
  modeSel: $('modeSel'), sendBtn: $('sendBtn'), resetBtn: $('resetBtn'),
};

let movie = { startImageUrl: null, shots: [] };
let playIndex = -1;          // index into readyShots()
let playingId = null;        // id of the shot on screen, so the index survives edits
let waitingForNext = false;  // playback ran out of footage mid-movie
let pollTimer = null;
const openPrompts = new Set(); // shot ids whose prompt disclosure is expanded

let exporting = false;        // an export is in flight; leave the button alone

const preloader = document.createElement('video');
preloader.preload = 'auto';
preloader.muted = true;

const readyShots = () => movie.shots.filter((s) => s.status === 'ready' && s.videoUrl);
const pendingShots = () => movie.shots.filter((s) => s.status === 'queued' || s.status === 'rendering');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ── Playback ─────────────────────────────────────────────── */

function playAt(i) {
  const shots = readyShots();
  if (i < 0 || i >= shots.length) return;
  const shot = shots[i];

  if (playIndex !== i || el.player.src !== shot.videoUrl) {
    el.player.src = shot.videoUrl;
  }
  playIndex = i;
  playingId = shot.id;
  waitingForNext = false;
  el.screen.classList.add('has-content', 'playing');
  el.player.play().catch(() => {}); // autoplay can be blocked before any gesture
  renderNowPlaying(shot);
  preloadNext();
  render();
}

function preloadNext() {
  const next = readyShots()[playIndex + 1];
  if (next && preloader.src !== next.videoUrl) preloader.src = next.videoUrl;
}

function renderNowPlaying(shot) {
  if (!shot || !shot.line) { el.nowPlaying.hidden = true; return; }
  el.nowPlaying.hidden = false;
  el.nowPlaying.innerHTML =
    `<span class="np-num">Shot ${shot.index}</span>${esc(shot.line)}`;
}

el.player.addEventListener('ended', () => {
  const shots = readyShots();
  if (playIndex + 1 < shots.length) {
    playAt(playIndex + 1);
  } else {
    // Hold the last frame and pick up automatically when the next shot lands.
    waitingForNext = true;
    render();
  }
});

el.player.addEventListener('play', render);
el.player.addEventListener('pause', render);

el.playBtn.addEventListener('click', () => {
  if (!el.player.paused) { el.player.pause(); return; }
  if (playIndex < 0) { playAt(0); return; }
  if (el.player.ended) {
    const shots = readyShots();
    if (playIndex + 1 < shots.length) return playAt(playIndex + 1);
    return playAt(0);
  }
  el.player.play().catch(() => {});
});

el.restartBtn.addEventListener('click', () => { playIndex = -1; playAt(0); });

/* ── Export ───────────────────────────────────────────────── */

el.downloadBtn.addEventListener('click', async () => {
  exporting = true;
  el.downloadBtn.disabled = true;
  el.downloadBtn.textContent = 'Stitching…';
  el.downloadError.hidden = true;

  let url;
  try {
    // Buffered rather than a plain navigation, so a failed stitch surfaces as a
    // message here instead of dumping JSON into a blank tab.
    const res = await fetch('/api/movie.mp4');
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Export failed (${res.status})`);
    }
    url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vibe-directing.mp4';
    a.click();
  } catch (err) {
    el.downloadError.hidden = false;
    el.downloadError.textContent = err.message;
  } finally {
    if (url) URL.revokeObjectURL(url);
    exporting = false;
    el.downloadBtn.textContent = 'Download movie';
    render();
  }
});

/* ── Rendering ────────────────────────────────────────────── */

function render() {
  const shots = movie.shots;
  const ready = readyShots();
  const pending = pendingShots();

  // Header
  const secs = ready.reduce((n, s) => n + (s.duration || 0), 0);
  el.headMeta.textContent = shots.length === 0
    ? 'No footage yet'
    : `${ready.length} shot${ready.length === 1 ? '' : 's'} · ${secs}s${pending.length ? ` · ${pending.length} rendering` : ''}`;

  // Busy pill
  el.busy.hidden = pending.length === 0;
  if (pending.length) {
    const next = pending[0];
    el.busyLabel.textContent = next.status === 'queued'
      ? `Shot ${next.index} queued…`
      : `Rendering shot ${next.index}…`;
  }

  // Opening still
  if (movie.startImageUrl) {
    el.drop.classList.add('filled');
    el.startThumb.hidden = false;
    if (el.startThumb.src !== movie.startImageUrl) el.startThumb.src = movie.startImageUrl;
    if (el.still.src !== movie.startImageUrl) el.still.src = movie.startImageUrl;
    el.screen.classList.add('has-content');
    if (playIndex < 0) el.screen.classList.add('still');
  } else {
    el.drop.classList.remove('filled');
    el.startThumb.hidden = true;
    el.screen.classList.remove('has-content', 'still', 'playing');
  }
  if (playIndex >= 0) el.screen.classList.remove('still');

  // Transport
  el.playBtn.textContent = el.player.paused || playIndex < 0 ? '▶' : '❚❚';
  el.playBtn.disabled = ready.length === 0;
  el.restartBtn.disabled = ready.length === 0;

  if (!exporting) {
    el.downloadBtn.disabled = ready.length === 0;
    el.downloadBtn.title = pending.length
      ? `Stitches the ${ready.length} finished shot${ready.length === 1 ? '' : 's'} into one file; ${pending.length} still rendering`
      : 'Stitch every shot into a single video file';
  }
  // Either box alone is a valid shot: dialogue, or action-only direction.
  el.sendBtn.disabled = !movie.startImageUrl
    || !(el.lineInput.value.trim() || el.directionInput.value.trim());

  renderReel(ready);
  renderBeats(ready);
}

function renderReel(ready) {
  el.reel.innerHTML = '';
  const currentId = ready[playIndex]?.id;
  for (const shot of movie.shots) {
    const cell = document.createElement('button');
    cell.className = 'reel-cell ' + (
      shot.status === 'ready' ? (shot.id === currentId ? 'ready current' : 'ready')
      : shot.status === 'failed' ? 'failed' : 'pending'
    );
    cell.textContent = shot.index;
    cell.title = shot.line || shot.direction || `Shot ${shot.index}`;
    if (shot.status === 'ready') {
      cell.addEventListener('click', () => playAt(ready.findIndex((s) => s.id === shot.id)));
    } else {
      cell.disabled = true;
    }
    el.reel.appendChild(cell);
  }
}

function renderBeats(ready) {
  const currentId = ready[playIndex]?.id;
  el.beats.innerHTML = '';

  for (const shot of movie.shots) {
    const li = document.createElement('li');
    li.className = 'beat ' + (
      shot.status === 'ready' ? (shot.id === currentId ? 'ready current' : 'ready')
      : shot.status === 'failed' ? 'failed' : 'pending'
    );

    const status = shot.status === 'ready' ? 'Ready'
      : shot.status === 'failed' ? 'Failed'
      : shot.status === 'rendering' ? '<span class="spinner"></span>Rendering'
      : '<span class="spinner"></span>Queued';

    li.innerHTML = `
      <div class="beat-top">
        <span class="beat-num">Shot ${shot.index}</span>
        <span>${shot.duration}s · ${esc(shot.resolution)}</span>
        <span class="beat-status">${status}</span>
      </div>
      ${shot.speaker && shot.line ? `<p class="beat-speaker">${esc(shot.speaker)}</p>` : ''}
      ${shot.line ? `<p class="beat-line">${esc(shot.line)}</p>` : ''}
      ${shot.direction ? `<p class="beat-direction">${esc(shot.direction)}</p>` : ''}
      ${shot.offChain ? `<p class="beat-offchain">Opens on a different frame than the shot before it — regenerate to restitch.</p>` : ''}
      ${shot.error ? `<p class="beat-error">${esc(shot.error)}</p>` : ''}
      ${shot.prompt ? `
        <details class="beat-prompt">
          <summary>Prompt</summary>
          <p><span class="pl">Sent</span>${esc(shot.prompt)}</p>
          ${shot.expandedPrompt
            ? `<p><span class="pl">Model expansion</span>${esc(shot.expandedPrompt)}</p>`
            : ''}
        </details>` : ''}
    `;

    const promptEl = li.querySelector('.beat-prompt');
    if (promptEl) {
      // Beats are rebuilt on every poll tick, so the open/closed state has to
      // live outside the DOM or it snaps shut while a shot is still rendering.
      promptEl.open = openPrompts.has(shot.id);
      // The beat itself seeks playback, so opening the prompt must not bubble.
      promptEl.addEventListener('click', (e) => e.stopPropagation());
      promptEl.addEventListener('toggle', () => {
        if (promptEl.open) openPrompts.add(shot.id);
        else openPrompts.delete(shot.id);
      });
    }

    if (shot.status === 'ready') {
      li.addEventListener('click', () => playAt(ready.findIndex((s) => s.id === shot.id)));
    }
    const actions = document.createElement('div');
    actions.className = 'beat-actions';
    actions.addEventListener('click', (e) => e.stopPropagation()); // don't seek

    const regen = document.createElement('button');
    regen.className = 'beat-act';
    regen.textContent = shot.status === 'failed' ? 'Retry' : 'Regenerate';
    regen.disabled = shot.status === 'queued' || shot.status === 'rendering';
    regen.title = 'Render this shot again from the frame the previous shot ends on';
    regen.addEventListener('click', () =>
      shotAction(`/api/shots/${shot.id}/regenerate`, 'POST'));

    // Deliberately allowed mid-render: it is the only way out of a stuck shot.
    const del = document.createElement('button');
    del.className = 'beat-act danger';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      if (!confirm(`Delete shot ${shot.index}? Its clip is not recoverable.`)) return;
      openPrompts.delete(shot.id);
      shotAction(`/api/shots/${shot.id}`, 'DELETE');
    });

    actions.append(regen, del);
    li.appendChild(actions);
    el.beats.appendChild(li);
  }
}

function stopPlayback() {
  playIndex = -1;
  playingId = null;
  waitingForNext = false;
  el.player.removeAttribute('src');
  el.player.load();
  el.screen.classList.remove('playing');
  el.nowPlaying.hidden = true;
}

/* ── Server sync ──────────────────────────────────────────── */

/** Delete and regenerate both answer with the whole movie. */
async function shotAction(url, method) {
  el.composerError.hidden = true;
  try {
    applyState(await api(url, { method }));
  } catch (err) {
    el.composerError.hidden = false;
    el.composerError.textContent = err.message;
  }
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function applyState(next) {
  const previouslyReady = new Set(readyShots().map((s) => s.id));
  movie = next;
  const ready = readyShots();

  // Shots can be deleted or sent back to render underneath us, so the position
  // has to be re-derived from the playing shot's identity - a bare index would
  // silently start pointing at a different clip.
  if (playingId) {
    const at = ready.findIndex((s) => s.id === playingId);
    if (at >= 0) {
      playIndex = at;
    } else {
      stopPlayback(); // the clip on screen is gone; don't sit on a stale src
    }
  }

  // A fresh shot landed while playback was waiting at the end of the reel.
  if (el.autoplayNew.checked) {
    const fresh = ready.find((s) => !previouslyReady.has(s.id));
    if (fresh && (playIndex < 0 || waitingForNext)) {
      playAt(ready.findIndex((s) => s.id === fresh.id));
      schedulePoll();
      return;
    }
  }
  render();
  preloadNext();
  schedulePoll();
}

async function refresh() {
  try { applyState(await api('/api/state')); }
  catch { schedulePoll(); }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (pendingShots().length) pollTimer = setTimeout(refresh, 2500);
}

/* ── Opening image ────────────────────────────────────────── */

async function useFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  el.openingNote.classList.remove('error');
  el.openingNote.textContent = 'Uploading opening frame…';

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  try {
    const next = await api('/api/start-image', {
      method: 'POST',
      body: JSON.stringify({ dataUrl, fileName: file.name }),
    });
    stopPlayback();
    el.openingNote.textContent = "This picture is the movie's first frame. Every following shot picks up where the previous one ended.";
    applyState(next);
    el.lineInput.focus();
  } catch (err) {
    el.openingNote.classList.add('error');
    el.openingNote.textContent = err.message;
  }
}

el.drop.addEventListener('click', () => { if (!movie.startImageUrl) el.fileInput.click(); });
el.fileInput.addEventListener('change', (e) => useFile(e.target.files[0]));
['dragenter', 'dragover'].forEach((ev) =>
  el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.remove('over'); }));
el.drop.addEventListener('drop', (e) => useFile(e.dataTransfer.files[0]));

/* ── Composer ─────────────────────────────────────────────── */

el.lineInput.addEventListener('input', render);
el.lineInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.composer.requestSubmit(); }
});

// Direction alone can carry a shot, so it has to drive the Send button too.
// No Enter-to-send here: it is prose, and newlines are worth more than a shortcut.
el.directionInput.addEventListener('input', render);

el.composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const line = el.lineInput.value.trim();
  const direction = el.directionInput.value.trim();
  if (!line && !direction) return;

  el.composerError.hidden = true;
  el.sendBtn.disabled = true;
  try {
    await api('/api/shots', {
      method: 'POST',
      body: JSON.stringify({
        line, direction,
        speaker: el.speakerInput.value.trim(),
        continuity: el.continuityChk.checked,
        duration: Number(el.durationSel.value),
        resolution: el.resolutionSel.value,
        promptExpansionMode: el.modeSel.value,
      }),
    });
    el.lineInput.value = '';
    el.directionInput.value = '';
    // speakerInput survives on purpose - a two-hander alternates between the
    // same couple of descriptions all scene, and retyping them is the chore.
    await refresh();
    el.storyScroll.scrollTop = el.storyScroll.scrollHeight;
  } catch (err) {
    el.composerError.hidden = false;
    el.composerError.textContent = err.message;
  } finally {
    render();
  }
});

el.resetBtn.addEventListener('click', async () => {
  if (movie.shots.length && !confirm('Start a new movie? The current storyline is cleared.')) return;
  const next = await api('/api/reset', { method: 'POST' });
  openPrompts.clear();
  el.speakerInput.value = '';
  stopPlayback();
  el.screen.className = 'screen';
  el.startThumb.removeAttribute('src');
  el.still.removeAttribute('src');
  applyState(next);
});

refresh();
