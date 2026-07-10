# Video Curator

A local, zero-dependency web app for triaging a folder of videos. It plays them
in shuffled order; you press **Keep** or **Reject** on each, and it records
progress so you can stop and resume later.

- **Keep** — leaves the file where it is.
- **Reject** — moves the file into a `_rejected` subfolder.
- **Undo** — reverses the last decision (restores a rejected file).

## Requirements

Node.js 18+. No packages to install.

## Run

Double-click `start.cmd`, or from a terminal:

```
node server.js "C:\path\to\your\videos"
```

Then open http://localhost:4321. Without a folder argument, the page prompts for
one. An optional second argument sets the port: `node server.js "C:\videos" 5000`.

## Controls

| Key | Action |
|---|---|
| `K` or `→` | Keep |
| `R` or `←` | Reject |
| `U` | Undo last decision |
| `M` | Mute / unmute |
| `Space` | Play / pause |

Videos start muted; click **Unmute** (or press `M`) to enable sound. Each video
plays through once — reaching the end without a decision counts as **Keep** and
the next one loads.

## Project layout

| File | Role |
|---|---|
| `server.js` | HTTP server: static assets, video streaming, review API |
| `index.html` | Page markup |
| `styles.css` | Styles |
| `app.js` | Client logic |
| `start.cmd` | Windows launcher (starts the server and opens the browser) |

## How it works

The server streams videos with HTTP range support and exposes a small JSON API
(`/api/status`, `/api/next`, `/api/decide`, `/api/undo`, `/api/reset`). Progress
lives in `.video-curator-progress.json` inside the video folder, so
already-reviewed files are skipped on the next run. Delete that file (or POST
`/api/reset`) to start over.

## Notes

- Supported extensions: mp4, m4v, webm, mov, ogv, mkv, avi. Browsers can't decode
  every codec (e.g. most `.avi`, some `.mkv`/`.mov`); for those the page shows the
  filename with a "cannot play" note and you can still keep or reject.
- The server listens only on localhost and rejects requests whose `Host` header
  isn't a loopback name, which defends against DNS-rebinding from other sites.
- It shuts down a few seconds after you close the browser tab; a refresh keeps it
  alive.

## License

MIT — see [LICENSE](LICENSE).
