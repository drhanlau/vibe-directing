# Continuous Movie

An AI movie that grows one line of dialogue at a time. Upload a starting picture,
type a line, and a clip is generated with
[MiniMax H3 Max image-to-video](https://fal.ai/models/minimax/h3-max/image-to-video)
on fal.ai and played in the left panel. Every new shot starts from the **last frame
of the previous shot**, so the clips play back as one continuous scene rather than
a set of unrelated videos.

## Layout

- **Left — the movie.** Video player, a shot reel you can click through, and
  continuous playback that rolls from one shot straight into the next. New shots
  join the end of the reel automatically as they finish.
- **Right — the storyline.** The opening frame, every beat of dialogue with its
  render status, and the composer.

## Setup

```bash
npm install
echo 'FAL_KEY=your-fal-key' > .env    # already present in this checkout
npm start
```

Open http://localhost:5174 (override with `PORT=... npm start`).

## How it works

| | |
|---|---|
| `POST /api/start-image` | Uploads the opening picture to fal storage, resets the movie. |
| `POST /api/shots` | Builds the prompt, submits to `minimax/h3-max/image-to-video`, renders in the background. |
| `GET /api/state` | Full storyline + shot statuses; the browser polls this while anything is rendering. |
| `POST /api/shots/:id/retry` | Re-runs a failed shot. |
| `POST /api/reset` | Clears the movie. |

The prompt sent to the model is assembled from your scene direction plus the
dialogue line, with a continuity instruction appended so the character, lighting
and grade carry across shots.

After a clip renders, the server pulls it down and runs
`ffmpeg -sseof -1 -update 1` to grab its final frame, uploads that frame to fal
storage, and uses it as `image_url` for the next shot. **ffmpeg must be on your
PATH** — without it the app still works, but each shot falls back to starting
from the previous shot's first frame, so continuity drifts.

## Notes

- The movie lives in memory in the server process; restarting clears it.
- Shot controls: 5s or 10s length, 480P or 768P, and `balanced` (~1s) or
  `quality` (~30s) prompt expansion.
- `Enter` sends a line, `Shift+Enter` adds a newline.
