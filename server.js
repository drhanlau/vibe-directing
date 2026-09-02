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
  direction: shot.direction,
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

const state = () => ({
  startImageUrl: movie.startImageUrl,
  shots: movie.shots.map(publicShot),
});

function buildPrompt({ line, direction }) {
  const parts = [];
  if (direction?.trim()) parts.push(direction.trim());
  if (line?.trim()) parts.push(`The character in frame speaks, lips synced: "${line.trim()}"`);
  parts.push('Continue the same scene, same character, same lighting and film grade.');
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
    console.error(`Shot ${shot.index} failed:`, err);
    shot.status = 'failed';
    shot.error = err?.body?.detail
      ? JSON.stringify(err.body.detail)
      : err.message || 'Generation failed';
  }
}

/** The image the next shot should start from. */
function currentTailImage() {
  for (let i = movie.shots.length - 1; i >= 0; i--) {
    const shot = movie.shots[i];
    if (shot.status === 'failed') continue;
    return shot.endImageUrl || shot.startImageUrl;
  }
  return movie.startImageUrl;
}

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
  const { line, direction, duration, resolution, promptExpansionMode } = req.body || {};
  if (!line?.trim() && !direction?.trim()) {
    return res.status(400).json({ error: 'Write a line of dialogue first.' });
  }
  const startImageUrl = currentTailImage();
  if (!startImageUrl) {
    return res.status(400).json({ error: 'Upload a starting image first.' });
  }

  const shot = {
    id: randomUUID(),
    index: movie.shots.length + 1,
    line: line?.trim() || '',
    direction: direction?.trim() || '',
    prompt: buildPrompt({ line, direction }),
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

app.post('/api/shots/:id/retry', (req, res) => {
  const shot = shotById(req.params.id);
  if (!shot) return res.status(404).json({ error: 'No such shot.' });
  if (shot.status === 'queued' || shot.status === 'rendering') {
    return res.status(409).json({ error: 'That shot is already rendering.' });
  }
  shot.status = 'queued';
  shot.error = null;
  shot.videoUrl = null;
  shot.endImageUrl = null;
  renderShot(shot);
  res.json({ shot: publicShot(shot) });
});

app.post('/api/reset', (_req, res) => {
  movie.startImageUrl = null;
  movie.shots = [];
  res.json(state());
});

app.listen(PORT, () => {
  console.log(`Continuous Movie running at http://localhost:${PORT}`);
});
