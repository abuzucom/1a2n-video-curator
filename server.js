// Video Curator - zero-dependency local server
// Usage: node server.js ["C:\path\to\videos"] [port]

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[3]) || 4321;
const REJECTED_DIR_NAME = '_rejected';
const PROGRESS_FILE = '.video-curator-progress.json';
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.mkv', '.avi']);

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
  const resolved = path.join(base, path.basename(name));
  if (!resolved.startsWith(base)) throw new Error('bad path');
  return resolved;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
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

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (start >= stat.size) {
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

    if (req.method === 'POST' && url.pathname === '/api/folder') {
      const body = await readBody(req);
      const folder = path.resolve(String(body.folder || ''));
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        return json(res, 400, { error: `Not a folder: ${folder}` });
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
    console.error(err);
    json(res, 500, { error: String(err.message || err) });
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
