// Video Curator - zero-dependency local server
// Usage: node server.js ["C:\path\to\videos"] [port]

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[3]) || 4321;
const REJECTED_DIR_NAME = '_rejected';
const PROGRESS_FILE = '.video-curator-progress.json';
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.mkv', '.avi']);

// Loopback host names we accept in the Host header. Anything else means the
// request was routed here from another origin (DNS rebinding) — reject it.
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Auto-shutdown: exit this long after the browser stops sending heartbeats.
const IDLE_SHUTDOWN_MS = 10000;

// Cap request bodies. Every body here is small JSON; anything larger is a bug
// or abuse, so we stop buffering rather than let memory grow unbounded.
const MAX_BODY_BYTES = 64 * 1024;

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

let state = {
  folder: process.argv[2] ? path.resolve(process.argv[2]) : null,
  queue: [],        // shuffled filenames still to review
  history: [],      // [{ file, action: 'keep'|'reject' }] this session, for undo
};

let lastSeen = 0;
let watchdog = null;

// Record that the browser just checked in, and lazily start a watchdog that
// exits the process once the heartbeats stop (tab or browser closed). soon=true
// (from the page's unload beacon) shortens the grace so a real close shuts down
// quickly, while a refresh — which reconnects within the grace — stays alive.
function touch(soon = false) {
  lastSeen = soon ? Date.now() - (IDLE_SHUTDOWN_MS - 3000) : Date.now();
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (Date.now() - lastSeen > IDLE_SHUTDOWN_MS) {
      console.log('Browser closed — shutting down.');
      process.exit(0);
    }
  }, 2000);
  if (watchdog.unref) watchdog.unref();
}

function progressPath() {
  return path.join(state.folder, PROGRESS_FILE);
}

function loadProgress() {
  try {
    return JSON.parse(fs.readFileSync(progressPath(), 'utf8'));
  } catch {
    return { reviewed: {} };
  }
}

function saveProgress(progress) {
  fs.writeFileSync(progressPath(), JSON.stringify(progress, null, 2));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Scan folder, drop already-reviewed files, shuffle the rest into the queue.
function scanFolder() {
  const progress = loadProgress();
  const files = fs.readdirSync(state.folder, { withFileTypes: true })
    .filter(d => d.isFile() && VIDEO_EXTS.has(path.extname(d.name).toLowerCase()))
    .map(d => d.name)
    .filter(name => !(name in progress.reviewed));
  state.queue = shuffle(files);
  state.history = [];
  return { remaining: files.length, reviewed: Object.keys(progress.reviewed).length };
}

function safeJoin(base, name) {
  const resolved = path.resolve(base, path.basename(name));
  const rel = path.relative(base, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('bad path');
  return resolved;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let aborted = false;
    req.on('data', c => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        const e = new Error('body too large'); e.statusCode = 413;
        return reject(e);
      }
      data += c;
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        const e = new Error('invalid JSON'); e.statusCode = 400;
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function streamVideo(req, res, filename) {
  let filePath;
  try { filePath = safeJoin(state.folder, filename); } catch { return json(res, 400, { error: 'bad path' }); }
  if (!fs.existsSync(filePath)) return json(res, 404, { error: 'not found' });

  const stat = fs.statSync(filePath);
  const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;

  if (m && (m[1] || m[2])) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Guard against DNS rebinding: only serve requests addressed to a loopback
  // host. A browser on another origin cannot forge one of these Host values.
  if (!ALLOWED_HOSTNAMES.has(url.hostname)) {
    return json(res, 403, { error: 'forbidden' });
  }

  touch();

  try {
    // --- static page ---
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }

    // --- set / get folder ---
    if (req.method === 'GET' && url.pathname === '/api/status') {
      if (!state.folder) return json(res, 200, { folder: null });
      const progress = loadProgress();
      return json(res, 200, {
        folder: state.folder,
        remaining: state.queue.length,
        reviewed: Object.keys(progress.reviewed).length,
        canUndo: state.history.length > 0,
      });
    }

    // --- heartbeat: the page pings periodically so the server knows a browser
    //     is still open; the unload beacon asks it to exit promptly ---
    if (req.method === 'GET' && url.pathname === '/api/ping') {
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/bye') {
      touch(true);
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'POST' && url.pathname === '/api/folder') {
      const body = await readBody(req);
      const folder = path.resolve(String(body.folder || ''));
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        return json(res, 400, { error: 'That path is not a folder, or does not exist.' });
      }
      state.folder = folder;
      const info = scanFolder();
      return json(res, 200, { folder, ...info });
    }

    if (!state.folder) return json(res, 400, { error: 'No folder selected' });

    // --- queue ---
    if (req.method === 'GET' && url.pathname === '/api/next') {
      const file = state.queue[0] || null;
      const progress = loadProgress();
      return json(res, 200, {
        file,
        remaining: state.queue.length,
        reviewed: Object.keys(progress.reviewed).length,
        canUndo: state.history.length > 0,
      });
    }

    // --- decide ---
    if (req.method === 'POST' && url.pathname === '/api/decide') {
      const body = await readBody(req);
      const { file, action } = body;
      if (!file || file !== state.queue[0]) return json(res, 409, { error: 'File is not current' });
      if (action !== 'keep' && action !== 'reject') return json(res, 400, { error: 'action must be keep or reject' });

      if (action === 'reject') {
        const rejectedDir = path.join(state.folder, REJECTED_DIR_NAME);
        fs.mkdirSync(rejectedDir, { recursive: true });
        const src = safeJoin(state.folder, file);
        let dest = path.join(rejectedDir, path.basename(file));
        // avoid clobbering an existing file with the same name
        let n = 1;
        while (fs.existsSync(dest)) {
          const ext = path.extname(file);
          dest = path.join(rejectedDir, `${path.basename(file, ext)} (${n++})${ext}`);
        }
        fs.renameSync(src, dest);
      }

      state.queue.shift();
      state.history.push({ file, action });
      const progress = loadProgress();
      progress.reviewed[file] = action;
      saveProgress(progress);
      return json(res, 200, { ok: true, remaining: state.queue.length });
    }

    // --- undo last decision (this session) ---
    if (req.method === 'POST' && url.pathname === '/api/undo') {
      const last = state.history.pop();
      if (!last) return json(res, 400, { error: 'Nothing to undo' });
      if (last.action === 'reject') {
        const src = path.join(state.folder, REJECTED_DIR_NAME, path.basename(last.file));
        if (fs.existsSync(src)) fs.renameSync(src, safeJoin(state.folder, last.file));
      }
      const progress = loadProgress();
      delete progress.reviewed[last.file];
      saveProgress(progress);
      state.queue.unshift(last.file);
      return json(res, 200, { ok: true, file: last.file });
    }

    // --- reset progress (forget reviews; does NOT restore rejected files) ---
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      saveProgress({ reviewed: {} });
      const info = scanFolder();
      return json(res, 200, { ok: true, ...info });
    }

    // --- video stream ---
    if (req.method === 'GET' && url.pathname === '/video') {
      return streamVideo(req, res, url.searchParams.get('f') || '');
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 500) console.error(err);
    json(res, code, { error: code === 500 ? 'internal error' : err.message });
  }
});

if (state.folder) {
  if (!fs.existsSync(state.folder) || !fs.statSync(state.folder).isDirectory()) {
    console.error(`Not a folder: ${state.folder}`);
    process.exit(1);
  }
  const info = scanFolder();
  console.log(`Folder: ${state.folder} (${info.remaining} to review, ${info.reviewed} already done)`);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Video Curator running at http://localhost:${PORT}`);
  if (!state.folder) console.log('No folder given - enter one in the browser page.');
});
