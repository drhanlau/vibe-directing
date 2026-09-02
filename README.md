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
| `POST /api/shots/:id/regenerate` | Re-renders one shot, from the frame the shot before it now ends on. |
| `DELETE /api/shots/:id` | Drops one shot and renumbers the rest. |
| `POST /api/reset` | Clears the movie. |

The prompt sent to the model is assembled from your scene direction, the dialogue
line, and a continuity instruction so the cast, lighting and grade carry across
shots. Each beat in the storyline has a **Prompt** disclosure showing both the
prompt that was sent and the model's own expansion of it.

After a clip renders, the server pulls it down and runs
`ffmpeg -sseof -1 -update 1` to grab its final frame, uploads that frame to fal
storage, and uses it as `image_url` for the next shot. **ffmpeg must be on your
PATH** — without it the app still works, but each shot falls back to starting
from the previous shot's first frame, so continuity drifts.

### Naming the speaker

With two or more actors in frame the model otherwise picks whoever it finds most
salient, which is often not who you meant. The **Who speaks** field becomes the
subject of the speech sentence:

> *the woman on the right, red hair* → `The woman on the right, red hair speaks, lips synced: "..."`

Describe the speaker by **position and appearance, not by name** — the model has
only the picture, so "Marcus" means nothing to it while "the man on the left in
the grey suit" is something it can resolve. It helps to also give the other actor
a silent action in the scene direction ("listens, jaw tight, doesn't speak"),
which suppresses the usual failure of animating both mouths. The field is kept
between shots, since a two-hander alternates between the same two descriptions.

### Shots without dialogue

Leave the dialogue box empty and write only scene direction to get an action
beat — a look, a move, a camera push — with no speech instruction in the prompt.

### Deleting and regenerating

Every beat has **Regenerate** and **Delete**. Regenerate re-renders the shot from
its prompt — the same prompt, so it is a second take, not an edit. Delete drops
the shot and renumbers the rest.

Both cut the chain. A shot's opening frame is the previous shot's *last* frame,
so removing or re-rendering a shot leaves the one after it opening on a frame
that no longer exists in the movie. Rather than silently re-rendering everything
downstream — which would spend your fal credits without asking — the shot after
the seam is marked **off-chain** in the storyline, and regenerating it stitches
the chain back up: regenerate pulls a fresh opening frame from whatever now
precedes it. Work downward and each regenerate clears the next break.

A failed shot is transparent to all of this: the chain reaches back through it to
the last shot that actually rendered, so one failure does not strand the rest.

Delete stays available while a shot is still rendering — it is the way out of a
shot that is stuck — and the in-flight render is discarded when it returns.

### Breaking continuity

*Hold continuity* (under Scene direction, on by default) appends "Continue the
same scene, same cast, same lighting and film grade." That is what you want for
"she turns her head", but it fights a real change — uncheck it when the direction
is a cut, a new location, or a lighting change.

## Notes

- The movie lives in memory in the server process; restarting clears it.
- Shot controls: 5s or 10s length, 480P or 768P, and `balanced` (~1s) or
  `quality` (~30s) prompt expansion.
- `Enter` sends a line, `Shift+Enter` adds a newline.
