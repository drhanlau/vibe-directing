import 'dotenv/config';
import express from 'express';
import { fal } from '@fal-ai/client';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODEL = 'minimax/h3-max/image-to-video';
const PORT = process.env.PORT || 5174;

if (!process.env.FAL_KEY) {
  console.error('Missing FAL_KEY. Add it to .env before starting the server.');
  process.exit(1);
}
fal.config({ credentials: process.env.FAL_KEY });

const app = express();
app.use(express.json({ limit: '32mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * The movie is a single in-memory session: an ordered list of shots. Each shot
 * starts from the previous shot's final frame, which is what makes playback
 * read as one continuous take rather than a pile of unrelated clips.
 */
const movie = {
  startImageUrl: null,
  shots: [],
};

const shotById = (id) => movie.shots.find((s) => s.id === id);

const publicShot = (shot) => ({
  id: shot.id,
  index: shot.index,
  line: shot.line,
  speaker: shot.speaker,
  direction: shot.direction,
  continuity: shot.continuity,
  prompt: shot.prompt,
  status: shot.status,
  error: shot.error,
  videoUrl: shot.videoUrl,
  posterUrl: shot.startImageUrl,
  expandedPrompt: shot.expandedPrompt,
  duration: shot.duration,
  resolution: shot.resolution,
  createdAt: shot.createdAt,
});

const state = () => {
  let expected = movie.startImageUrl;
  const shots = movie.shots.map((shot) => {
    // Off-chain: this shot no longer opens on the frame the one before it ends
    // on. That is what deleting or regenerating an earlier shot leaves behind,
    // and it is the difference between a continuous take and a jump cut.
    const offChain = Boolean(expected) && shot.startImageUrl !== expected;
    if (shot.status !== 'failed') expected = shot.endImageUrl || shot.startImageUrl;
    return { ...publicShot(shot), offChain };
  });
  return { startImageUrl: movie.startImageUrl, shots };
};

/**
 * Turn the free-text speaker note into the subject of the speech sentence.
 * Positional/visual descriptions ("the woman on the right, red hair") are what
 * the model can actually resolve against the frame - a name means nothing to it.
 */
function speakerSubject(speaker) {
  const who = speaker?.trim().replace(/[.\s]+$/, '');
  if (!who) return 'The character in frame';
  return who.charAt(0).toUpperCase() + who.slice(1);
}

function buildPrompt({ line, direction, speaker, continuity = true }) {
  const parts = [];
  if (direction?.trim()) parts.push(direction.trim());
  if (line?.trim()) {
    parts.push(`${speakerSubject(speaker)} speaks, lips synced: "${line.trim()}"`);
  }
  // Off when the shot is meant to change something - the continuity sentence
  // pulls the model back toward the previous frame and fights a real cut.
  if (continuity) parts.push('Continue the same scene, same cast, same lighting and film grade.');
  return parts.join(' ');
}

/** Grab the final frame of a rendered clip so the next shot can start there. */
async function extractLastFrame(videoUrl) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'contmovie-'));
  const videoPath = path.join(dir, 'clip.mp4');
  const framePath = path.join(dir, 'last.jpg');
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`Could not download clip (${res.status})`);
    await fs.writeFile(videoPath, Buffer.from(await res.arrayBuffer()));

    // sseof seeks from the end of the file; -update keeps overwriting so the
    // file left behind is the very last decoded frame.
    await execFileAsync('ffmpeg', [
      '-y', '-sseof', '-1', '-i', videoPath,
      '-update', '1', '-q:v', '2', framePath,
    ]);

    const frame = await fs.readFile(framePath);
    const uploaded = await fal.storage.upload(
      new File([frame], 'last-frame.jpg', { type: 'image/jpeg' })
    );
    return uploaded;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function renderShot(shot) {
  try {
    shot.status = 'rendering';
    const result = await fal.subscribe(MODEL, {
      input: {
        prompt: shot.prompt,
        prompt_expansion_mode: shot.promptExpansionMode,
        image_url: shot.startImageUrl,
        duration: shot.duration,
        resolution: shot.resolution,
      },
      logs: false,
      onQueueUpdate: (update) => {
        if (update.status === 'IN_QUEUE') shot.status = 'queued';
        if (update.status === 'IN_PROGRESS') shot.status = 'rendering';
      },
    });

    // The shot can be deleted while fal is still working on it; anything past
    // this point (including the frame upload) would be work for a ghost.
    if (!movie.shots.includes(shot)) return;

    shot.videoUrl = result.data?.video?.url;
    shot.expandedPrompt = result.data?.expanded_prompt;
    if (!shot.videoUrl) throw new Error('fal returned no video URL');
    shot.status = 'ready';

    // Best-effort continuity: if the frame grab fails the movie still plays,
    // the next shot just falls back to the previous starting frame.
    try {
      shot.endImageUrl = await extractLastFrame(shot.videoUrl);
    } catch (err) {
      console.warn(`Last-frame extraction failed for shot ${shot.index}:`, err.message);
      shot.endImageUrl = shot.startImageUrl;
    }
  } catch (err) {
    if (!movie.shots.includes(shot)) return;
    console.error(`Shot ${shot.index} failed:`, err);
    shot.status = 'failed';
    shot.error = err?.body?.detail
      ? JSON.stringify(err.body.detail)
      : err.message || 'Generation failed';
  }
}

/**
 * The frame the shot at array index `i` should open on: the end of the nearest
 * preceding shot that actually rendered. Failed shots are transparent - the
 * chain reaches back through them.
 */
function tailImageBefore(i) {
  for (let j = i - 1; j >= 0; j--) {
    const shot = movie.shots[j];
    if (shot.status === 'failed') continue;
    return shot.endImageUrl || shot.startImageUrl;
  }
  return movie.startImageUrl;
}

/** The image the next shot should start from. */
const currentTailImage = () => tailImageBefore(movie.shots.length);

app.get('/api/state', (_req, res) => res.json(state()));

app.post('/api/start-image', async (req, res) => {
  try {
    const { dataUrl, fileName } = req.body || {};
    if (!dataUrl?.startsWith('data:')) {
      return res.status(400).json({ error: 'Expected an image data URL.' });
    }
    const [meta, base64] = dataUrl.split(',');
    const type = meta.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
    const buffer = Buffer.from(base64, 'base64');
    const url = await fal.storage.upload(
      new File([buffer], fileName || 'start.jpg', { type })
    );

    movie.startImageUrl = url;
    movie.shots = [];
    res.json(state());
  } catch (err) {
    console.error('Start image upload failed:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

app.post('/api/shots', (req, res) => {
  const {
    line, speaker, direction, continuity,
    duration, resolution, promptExpansionMode,
  } = req.body || {};
  if (!line?.trim() && !direction?.trim()) {
    return res.status(400).json({ error: 'Write a line of dialogue or some scene direction first.' });
  }
  const startImageUrl = currentTailImage();
  if (!startImageUrl) {
    return res.status(400).json({ error: 'Upload a starting image first.' });
  }

  const shot = {
    id: randomUUID(),
    index: movie.shots.length + 1,
    line: line?.trim() || '',
    speaker: speaker?.trim() || '',
    direction: direction?.trim() || '',
    continuity: continuity !== false,
    prompt: buildPrompt({ line, direction, speaker, continuity: continuity !== false }),
    startImageUrl,
    endImageUrl: null,
    videoUrl: null,
    expandedPrompt: null,
    status: 'queued',
    error: null,
    duration: Number(duration) || 5,
    resolution: resolution === '480P' ? '480P' : '768P',
    promptExpansionMode: promptExpansionMode === 'quality' ? 'quality' : 'balanced',
    createdAt: Date.now(),
  };

  movie.shots.push(shot);
  renderShot(shot);
  res.status(202).json({ shot: publicShot(shot) });
});

app.post('/api/shots/:id/regenerate', (req, res) => {
  const i = movie.shots.findIndex((s) => s.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'No such shot.' });
  const shot = movie.shots[i];
  if (shot.status === 'queued' || shot.status === 'rendering') {
    return res.status(409).json({ error: 'That shot is already rendering.' });
  }

  // Re-derive the opening frame rather than reusing the stored one: if an
  // earlier shot was deleted or re-rendered, the stored frame is stale and
  // regenerating is exactly how the chain gets stitched back together.
  const startImageUrl = tailImageBefore(i);
  if (!startImageUrl) {
    return res.status(400).json({ error: 'Upload a starting image first.' });
  }

  shot.startImageUrl = startImageUrl;
  shot.status = 'queued';
  shot.error = null;
  shot.videoUrl = null;
  shot.endImageUrl = null;
  shot.expandedPrompt = null;
  renderShot(shot);
  res.json(state());
});

app.delete('/api/shots/:id', (req, res) => {
  const i = movie.shots.findIndex((s) => s.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'No such shot.' });

  // Removing a shot renumbers the ones after it, but deliberately leaves their
  // rendered video alone - they are reported off-chain instead, so the cost of
  // re-rendering stays the user's call.
  movie.shots.splice(i, 1);
  movie.shots.forEach((shot, n) => { shot.index = n + 1; });
  res.json(state());
});

app.post('/api/reset', (_req, res) => {
  movie.startImageUrl = null;
  movie.shots = [];
  res.json(state());
});

app.listen(PORT, () => {
  console.log(`Continuous Movie running at http://localhost:${PORT}`);
});
