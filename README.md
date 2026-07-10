# Video Curator

A tiny local app for triaging a large folder of videos. It plays them in
shuffled order; you press **Keep** or **Reject** on each one.

- **Keep** — leaves the file where it is.
- **Reject** — moves the file into a `_rejected` subfolder inside your video folder.
- **Undo** — reverses your last decision (moves a rejected file back).

Progress is saved to `.video-curator-progress.json` inside the video folder, so
you can close the app and resume later — already-reviewed videos won't be shown
again. Delete that file (or POST `/api/reset`) to start over.

## Requirements

Node.js (any recent version). No packages to install.

## Run

Double-click `start.cmd`, or from a terminal:

```
node server.js "C:\path\to\your\videos"
```

Then open http://localhost:4321. If you don't pass a folder on the command
line, the page asks for one.

Optional second argument sets the port: `node server.js "C:\videos" 5000`.

## Controls

| Key | Action |
|---|---|
| `K` or `→` | Keep |
| `R` or `←` | Reject |
| `U` | Undo last decision |
| `M` | Mute / unmute |
| `Space` | Play / pause |

Videos play through once. If a video reaches the end without a decision, it
counts as **Keep** and the next one loads automatically. The player has normal
controls for scrubbing, volume, and fullscreen.
Videos start muted; click **Unmute** (or press `M`) to enable sound. Your
choice carries over to the next video.

Videos loop automatically; the player has normal controls for scrubbing,
volume, and fullscreen.

## Notes

- Supported extensions: mp4, m4v, webm, mov, ogv, mkv, avi. Browsers can't
  decode every codec (e.g. most `.avi`, some `.mkv`/`.mov`); for those the page
  shows the filename with a "cannot play" note and you can still keep or reject.
- The server only listens on localhost, and rejects requests whose `Host`
  header isn't a loopback name (defends against DNS-rebinding from other sites).
- The server shuts itself down a few seconds after you close the browser tab,
  so it doesn't keep running in the background. A refresh keeps it alive.
