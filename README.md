# Video Curator

A local, zero-dependency web app for triaging a folder of videos. It plays them
in shuffled order; you press **Keep** or **Reject** on each.

- **Keep** — moves the file into a `_keep` subfolder.
- **Reject** — moves the file into a `_rejected` subfolder.
- **Undo** — reverses the last decision (restores a rejected or kept file back to the root folder).

## Requirements

Node.js 18+. No packages to install.

## Run

Double-click `start.cmd`, or from a terminal:

```
node server.js "C:\path\to\your\videos"
```

Then open http://localhost:4321. Without a folder argument, the page prompts for
one. You can paste the absolute path or click the **Browse...** button to launch
the native OS folder picker dialogue. An optional second argument sets the port:
`node server.js "C:\videos" 5000`.

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
the next one loads. The player has normal controls for scrubbing, volume, and
fullscreen.

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
(`/api/status`, `/api/next`, `/api/decide`, `/api/undo`, `/api/reset`). While
running, it tracks decisions in a `.video-curator-progress.json` file inside the
video folder so it can skip already-reviewed videos during the session. That
file is removed automatically when the server stops (closing the browser tab
shuts it down within seconds), so nothing is left in your folder and progress
does not carry across runs.

## Notes

- Supported extensions: mp4, m4v, webm, mov, ogv, mkv, avi. Browsers can't decode
  every codec (e.g. most `.avi`, some `.mkv`/`.mov`); for those the page shows the
  filename with a "cannot play" note and you can still keep or reject.
- The server binds strictly to the loopback interface (`127.0.0.1` / `::1`) and performs an address safety check at startup, immediately refusing to start if run on any non-loopback interface. It rejects requests whose `Host` header isn't a loopback name, which defends against DNS-rebinding.
- Strict folder path validation checks are applied: web URLs, file paths with extensions, non-local network/UNC paths, system directories (like `%windir%` on Windows, or `/boot`, `/etc`, `/root`, `/proc`, `/sys` on Linux/macOS), IP hosts, and names containing emojis or box-drawing characters are rejected. Korean, Chinese, Japanese, Arabic, and Vietnamese script folders are fully supported.
- Offline execution: to prevent external network egress, the server validates localhost mappings directly via the local hosts file without querying remote DNS servers.
- It shuts down a few seconds after you close the browser tab; a refresh keeps it alive.

## License

MIT — see [LICENSE](LICENSE).
