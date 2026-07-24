// Video Curator - zero-dependency local server
// Usage: node server.js ["C:\path\to\videos"] [port]

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const net = require('net');
const os = require('os');
const crypto = require('crypto');

let PORT = Number(process.argv[3]) || 4321;
const API_TOKEN = crypto.randomBytes(32).toString('hex');
const REJECTED_DIR_NAME = '_rejected';
const KEEP_DIR_NAME = '_keep';
const PROGRESS_FILE = '.video-curator-progress.json';
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.mkv', '.avi']);

// Host values we accept; anything else means a cross-origin request
// (DNS rebinding) and is rejected.
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Auto-shutdown: exit this long after browser heartbeats stop.
const IDLE_SHUTDOWN_MS = 10000;

// Cap request bodies (all small JSON) to bound memory use.
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

// Static files served from this directory. Fixed keys, so no user path input.
const ASSETS = {
  '/':           ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js':     ['app.js',     'text/javascript; charset=utf-8'],
};

function isGuiAvailable() {
  if (process.env.TESTING) return false;
  if (process.platform === 'win32') {
    const session = process.env.SESSIONNAME;
    if (session && session.toLowerCase().startsWith('services')) {
      return false;
    }
    return true;
  }
  if (process.platform === 'darwin') {
    return true;
  }
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function showNativeErrorDialog(message, title = 'Security Error') {
  if (!isGuiAvailable()) return;

  try {
    const env = {
      ...process.env,
      DIALOG_MSG: message,
      DIALOG_TITLE: title
    };

    if (process.platform === 'win32') {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:DIALOG_MSG, $env:DIALOG_TITLE, 0, 16)'
      ], { stdio: 'ignore', env });
    } else if (process.platform === 'darwin') {
      execFileSync('osascript', [
        '-e',
        'display dialog (system attribute "DIALOG_MSG") with title (system attribute "DIALOG_TITLE") buttons {"OK"} default button 1 with icon stop'
      ], { stdio: 'ignore', env });
    } else {
      try {
        execFileSync('zenity', [
          '--error',
          '--title=' + title,
          '--text=' + message
        ], { stdio: 'ignore' });
      } catch (err) {
        try {
          execFileSync('kdialog', [
            '--error',
            message,
            '--title',
            title
          ], { stdio: 'ignore' });
        } catch (fbErr) {}
      }
    }
  } catch (err) {
    console.error(`Fallback console error [${title}]: ${message}`);
  }
}

function showNativeFolderPicker() {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      execFile('powershell.exe', [
        '-NoProfile',
        '-WindowStyle', 'Hidden',
        '-Command',
        // A TopMost owner form is required so the dialog comes to the
        // foreground instead of opening behind the browser window: Node
        // has no window of its own, so Windows' focus-stealing prevention
        // otherwise leaves the dialog stuck behind the active window.
        "Add-Type -AssemblyName System.Windows.Forms; $owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select Video Folder'; $f.ShowNewFolderButton = $false; $r = $f.ShowDialog($owner); $owner.Dispose(); if ($r -eq 'OK') { Write-Output $f.SelectedPath }"
      ], { windowsHide: true }, (error, stdout) => {
        if (error) {
          return reject(new Error('Failed to open directory dialog: ' + error.message));
        }
        resolve(stdout.trim() || null);
      });
    } else if (process.platform === 'darwin') {
      execFile('osascript', [
        '-e',
        'POSIX path of (choose folder with prompt "Select a folder containing your videos")'
      ], (error, stdout) => {
        if (error) {
          if (error.message.includes('User canceled')) {
            return resolve(null);
          }
          return reject(new Error('Failed to open directory dialog: ' + error.message));
        }
        resolve(stdout.trim() || null);
      });
    } else {
      execFile('zenity', [
        '--file-selection',
        '--directory',
        '--title=Select a folder containing your videos'
      ], (error, stdout) => {
        if (error) {
          if (error.code !== 'ENOENT') {
            return resolve(null); // user canceled the dialog
          }
          execFile('kdialog', ['--getexistingdirectory'], (fbError, fbStdout) => {
            if (fbError) {
              if (fbError.code !== 'ENOENT') {
                return resolve(null); // user canceled the dialog
              }
              return reject(new Error(
                'No folder-picker tool found (zenity or kdialog). Install one, or paste the folder path directly.'
              ));
            }
            resolve(fbStdout.trim() || null);
          });
          return;
        }
        resolve(stdout.trim() || null);
      });
    }
  });
}

function verifyLocalhostInHostsFile() {
  let hostsPath;
  if (process.platform === 'win32') {
    const winDir = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    hostsPath = path.join(winDir, 'System32\\drivers\\etc\\hosts');
  } else {
    hostsPath = '/etc/hosts';
  }

  if (!fs.existsSync(hostsPath)) {
    return;
  }

  const content = fs.readFileSync(hostsPath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const cleanLine = line.split('#')[0].trim();
    if (!cleanLine) continue;

    const parts = cleanLine.split(/\s+/);
    if (parts.length >= 2) {
      const ip = parts[0];
      const hostnames = parts.slice(1).map(h => h.toLowerCase());

      if (hostnames.includes('localhost')) {
        if (ip !== '127.0.0.1' && ip !== '::1') {
          throw new Error(`Security Exception: localhost mapped to non-loopback IP ${ip} in hosts file.`);
        }
      }
    }
  }
}

function isIPAddress(host) {
  if (net.isIP(host)) return true;
  if (host.toLowerCase().endsWith('.ipv6-literal.net')) return true;
  if (host.startsWith('[') && host.endsWith(']')) {
    const inside = host.slice(1, -1);
    if (net.isIP(inside)) return true;
  }
  return false;
}

function hasProhibitedCharacters(str) {
  if (/\p{Extended_Pictographic}/u.test(str)) return true;
  if (/[\x00-\x1F\x7F-\x9F]/.test(str)) return true;
  if (/[\u2500-\u259F]/.test(str)) return true;
  return false;
}

function validateFolderPath(folderPath) {
  if (!folderPath) {
    throw new Error('Path is required.');
  }

  const rawPath = String(folderPath).trim();

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawPath)) {
    throw new Error('Web URLs or protocols are not allowed.');
  }

  const ext = path.extname(rawPath);
  if (ext && ext.startsWith('.') && ext.length > 1) {
    throw new Error('Paths with file extensions are not allowed. Please select a folder.');
  }

  if (hasProhibitedCharacters(rawPath)) {
    throw new Error('The selected path contains prohibited characters (emojis or invalid symbols).');
  }

  const isNetworkPath = rawPath.startsWith('\\\\') || rawPath.startsWith('//');
  if (isNetworkPath) {
    const hostSegment = rawPath.substring(2).split(/[/\\]/)[0];
    if (hostSegment) {
      if (isIPAddress(hostSegment)) {
        throw new Error('IP addresses are not allowed.');
      }
      if (hostSegment.toLowerCase() === 'localhost') {
        verifyLocalhostInHostsFile();
      } else {
        const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
        const systemHostname = os.hostname().toLowerCase();
        if (systemHostname && !systemHostname.includes('.')) {
          localHosts.add(systemHostname);
        }
        if (!localHosts.has(hostSegment.toLowerCase())) {
          throw new Error('Non-local network paths are not allowed.');
        }
      }
    }
  }

  let resolved = path.resolve(rawPath);
  try {
    resolved = fs.realpathSync(resolved);
  } catch (err) {
    // Best-effort symlink canonicalization: the path may not exist yet, or
    // realpath may be unsupported for the underlying volume (e.g. mapped
    // network drives / virtual drives on Windows that don't fully implement
    // reparse-point resolution). Fall back to the non-canonicalized path
    // rather than blocking folder selection outright; the prohibited-dir
    // check below still runs against it.
  }

  if (process.platform === 'win32') {
    const prohibitedDirs = [];
    if (process.env.windir) prohibitedDirs.push(path.resolve(process.env.windir));
    if (process.env.SystemRoot) prohibitedDirs.push(path.resolve(process.env.SystemRoot));
    if (process.env.ProgramFiles) prohibitedDirs.push(path.resolve(process.env.ProgramFiles));
    if (process.env['ProgramFiles(x86)']) prohibitedDirs.push(path.resolve(process.env['ProgramFiles(x86)']));
    if (process.env.ProgramData) prohibitedDirs.push(path.resolve(process.env.ProgramData));
    if (process.env.APPDATA) prohibitedDirs.push(path.resolve(process.env.APPDATA));
    if (process.env.LOCALAPPDATA) prohibitedDirs.push(path.resolve(process.env.LOCALAPPDATA));
    if (process.env.USERPROFILE) prohibitedDirs.push(path.resolve(path.join(process.env.USERPROFILE, 'AppData')));

    prohibitedDirs.push('C:\\Windows');
    prohibitedDirs.push('C:\\Program Files');
    prohibitedDirs.push('C:\\Program Files (x86)');
    prohibitedDirs.push('C:\\ProgramData');

    const normalizedResolved = resolved.toLowerCase().replace(/[/\\]$/, '');

    for (const dir of prohibitedDirs) {
      const normalizedDir = dir.toLowerCase();
      if (normalizedResolved === normalizedDir || normalizedResolved.startsWith(normalizedDir + '\\') || normalizedResolved.startsWith(normalizedDir + '/')) {
        throw new Error(`Access to Windows system directory ${dir} is prohibited.`);
      }
    }
  } else {
    const prohibitedDirs = ['/boot', '/etc', '/root', '/proc', '/sys'];
    const normalizedResolved = resolved === '/' ? '/' : resolved.replace(/\/$/, '');

    for (const dir of prohibitedDirs) {
      if (normalizedResolved === dir || normalizedResolved.startsWith(dir + '/')) {
        throw new Error(`Access to system directory ${dir} is prohibited.`);
      }
    }
  }

  return resolved;
}

let state = {
  folder: process.argv[2] ? path.resolve(process.argv[2]) : null,
  queue: [],        // shuffled filenames still to review
  history: [],      // [{ file, action: 'keep'|'reject' }] this session, for undo
};

let activeVideoStreams = 0;
const rateLimitStore = {};

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  if (!rateLimitStore[key]) {
    rateLimitStore[key] = [];
  }
  rateLimitStore[key] = rateLimitStore[key].filter(t => now - t < windowMs);
  if (rateLimitStore[key].length >= limit) {
    return false;
  }
  rateLimitStore[key].push(now);
  return true;
}

let lastSeen = 0;
let watchdog = null;

// Mark a browser check-in and lazily start a watchdog that exits once
// heartbeats stop (tab/browser closed). soon=true (unload beacon) shortens the
// grace for a prompt close; a refresh reconnects within the grace and survives.
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
  const target = progressPath();
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error('Security Exception: Target path is a symbolic link or non-regular file.');
    }
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (err) {
    if (err.message.includes('Security Exception')) {
      throw err;
    }
    return { reviewed: {} };
  }
}

function saveProgress(progress) {
  const target = progressPath();

  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error('Security Exception: Target path is a symbolic link or non-regular file.');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const targetDir = path.dirname(path.resolve(target));
  const expectedDir = path.resolve(state.folder);
  if (targetDir !== expectedDir) {
    throw new Error('Security Exception: Target directory mismatch.');
  }

  const tmpPath = target + '.tmp';

  try {
    const st = fs.lstatSync(tmpPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      fs.unlinkSync(tmpPath);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  fs.writeFileSync(tmpPath, JSON.stringify(progress, null, 2));
  fs.renameSync(tmpPath, target);
}

// Delete the session's progress file on shutdown. Constrained to exactly that
// one file inside the chosen folder: never a directory, symlink, or video.
function cleanupProgress() {
  const folder = state.folder;
  if (!folder) return;
  const target = path.join(folder, PROGRESS_FILE);
  if (path.basename(target) !== PROGRESS_FILE) return;                       // exact name
  if (path.dirname(path.resolve(target)) !== path.resolve(folder)) return;   // inside folder only
  try {
    const st = fs.lstatSync(target);   // lstat: never follow a symlink
    if (!st.isFile()) return;          // never a directory/symlink/device
    fs.unlinkSync(target);             // one file only, never recursive
  } catch (err) {
    // Ignore error if progress file doesn't exist or is already deleted
  }
}

function validateRequestAuthenticity(req, url) {
  const tokenHeader = req.headers['x-api-token'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const tokenQuery = url.searchParams.get('t');
  const token = tokenHeader || tokenQuery;

  if (!token || token !== API_TOKEN) {
    throw new Error('Unauthorized');
  }

  const origin = req.headers['origin'];
  const referer = req.headers['referer'];

  const allowedOrigins = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://[::1]:${PORT}`
  ]);

  if (origin) {
    if (!allowedOrigins.has(origin)) {
      throw new Error('Forbidden Origin');
    }
  } else if (referer) {
    try {
      const refUrl = new URL(referer);
      const refOrigin = `${refUrl.protocol}//${refUrl.host}`;
      if (!allowedOrigins.has(refOrigin)) {
        throw new Error('Forbidden Referer');
      }
    } catch {
      throw new Error('Invalid Referer');
    }
  }
}

function verifyCurationDirectory(dirName) {
  const dirPath = path.join(state.folder, dirName);

  try {
    const st = fs.lstatSync(dirPath);
    if (st.isSymbolicLink()) {
      throw new Error(`Security Exception: Directory '${dirName}' is a symbolic link.`);
    }
    if (!st.isDirectory()) {
      throw new Error(`Security Exception: Path '${dirName}' is not a directory.`);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      fs.mkdirSync(dirPath, { recursive: true });
    } else {
      throw err;
    }
  }

  const canonicalFolder = fs.realpathSync(state.folder);
  const canonicalDest = fs.realpathSync(dirPath);

  const relativePath = path.relative(canonicalFolder, canonicalDest);
  if (relativePath !== dirName) {
    throw new Error(`Security Exception: Canonical path for '${dirName}' resolved outside the folder tree.`);
  }

  return canonicalDest;
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// Scan folder, drop already-reviewed files, shuffle the rest into the queue.
function scanFolder() {
  const progress = loadProgress();
  const files = fs.readdirSync(state.folder, { withFileTypes: true })
    .filter(entry => entry.isFile() && VIDEO_EXTS.has(path.extname(entry.name).toLowerCase()))
    .map(entry => entry.name)
    .filter(name => !(name in progress.reviewed));
  state.queue = shuffle(files);
  state.history = [];
  return { remaining: files.length, reviewed: Object.keys(progress.reviewed).length };
}

function safeJoin(base, name) {
  const resolvedBase = path.resolve(base);
  const resolvedPath = path.resolve(resolvedBase, path.basename(name));
  const relativePath = path.relative(resolvedBase, resolvedPath);
  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('bad path');
  }
  return resolvedPath;
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let rawBody = '';
    let byteCount = 0;
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      byteCount += chunk.length;
      if (byteCount > MAX_BODY_BYTES) {
        aborted = true;
        const error = new Error('body too large'); error.statusCode = 413;
        return reject(error);
      }
      rawBody += chunk;
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(rawBody ? JSON.parse(rawBody) : {});
      } catch {
        const error = new Error('invalid JSON'); error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function streamVideo(req, res, filename) {
  let filePath;
  try {
    filePath = safeJoin(state.folder, filename);
  } catch {
    return json(res, 400, { error: 'bad path' });
  }

  let fd;
  try {
    let flags = fs.constants.O_RDONLY;
    if (fs.constants.O_NOFOLLOW) {
      flags |= fs.constants.O_NOFOLLOW;
    }
    fd = fs.openSync(filePath, flags);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return json(res, 404, { error: 'not found' });
    }
    return json(res, 400, { error: err.message });
  }

  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) {
      fs.closeSync(fd);
      return json(res, 400, { error: 'not a file' });
    }

    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    const rangeMatch = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;

    if (rangeMatch && (rangeMatch[1] || rangeMatch[2])) {
      let start;
      let end;
      if (!rangeMatch[1] && rangeMatch[2]) {
        const suffixLength = parseInt(rangeMatch[2], 10);
        start = Math.max(0, stats.size - suffixLength);
        end = stats.size - 1;
      } else {
        start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
        end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : stats.size - 1;
      }

      if (start > end || start >= stats.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
        fs.closeSync(fd);
        return res.end();
      }
      end = Math.min(end, stats.size - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime,
      });
      fs.createReadStream(null, { fd, start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stats.size,
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(null, { fd }).pipe(res);
    }
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {}
    return json(res, 500, { error: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Block DNS rebinding: serve only loopback Host values, which a page on
  // another origin cannot forge.
  if (!ALLOWED_HOSTNAMES.has(url.hostname)) {
    return json(res, 403, { error: 'forbidden' });
  }

  touch();

  try {
    if (url.pathname === '/api/ping') {
      if (!rateLimit('ping', 60, 60000)) {
        return json(res, 429, { error: 'Too many requests' });
      }
    } else if (req.method === 'POST') {
      if (!rateLimit('api-post', 100, 60000)) {
        return json(res, 429, { error: 'Too many requests' });
      }
    }

    if (req.method === 'POST') {
      try {
        validateRequestAuthenticity(req, url);
      } catch (err) {
        const statusCode = err.message === 'Unauthorized' ? 401 : 403;
        return json(res, statusCode, { error: err.message });
      }
    }

    // --- static assets ---
    if (req.method === 'GET' && url.pathname === '/') {
      let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      html = html.replace('</head>', `<script>window.API_TOKEN = "${API_TOKEN}";</script>\n</head>`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    const asset = ASSETS[url.pathname];
    if (req.method === 'GET' && asset) {
      const [file, type] = asset;
      res.writeHead(200, { 'Content-Type': type });
      return res.end(fs.readFileSync(path.join(__dirname, file)));
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

    // --- heartbeat: pings keep the server alive; the unload beacon exits it ---
    if (req.method === 'GET' && url.pathname === '/api/ping') {
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/bye') {
      touch(true);
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'POST' && url.pathname === '/api/browse') {
      try {
        const folder = await showNativeFolderPicker();
        if (folder) {
          const validated = validateFolderPath(folder);
          return json(res, 200, { folder: validated });
        }
        return json(res, 200, { folder: null });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/folder') {
      const body = await readBody(req);
      let folder;
      try {
        folder = validateFolderPath(body.folder);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
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

      let movedAs = file;
      if (action === 'reject' || action === 'keep') {
        const targetDirName = action === 'reject' ? REJECTED_DIR_NAME : KEEP_DIR_NAME;
        const targetDir = verifyCurationDirectory(targetDirName);
        const sourcePath = safeJoin(state.folder, file);
        let destPath = path.join(targetDir, path.basename(file));
        // avoid clobbering an existing file with the same name
        let duplicateCount = 1;
        while (fs.existsSync(destPath)) {
          const extension = path.extname(file);
          destPath = path.join(targetDir, `${path.basename(file, extension)} (${duplicateCount++})${extension}`);
        }
        fs.renameSync(sourcePath, destPath);
        movedAs = path.basename(destPath);
      }

      state.queue.shift();
      state.history.push({ file, action, movedAs });
      const progress = loadProgress();
      progress.reviewed[file] = action;
      saveProgress(progress);
      return json(res, 200, { ok: true, remaining: state.queue.length });
    }

    // --- undo last decision (this session) ---
    if (req.method === 'POST' && url.pathname === '/api/undo') {
      const lastDecision = state.history.pop();
      if (!lastDecision) return json(res, 400, { error: 'Nothing to undo' });
      if (lastDecision.action === 'reject' || lastDecision.action === 'keep') {
        const targetDirName = lastDecision.action === 'reject' ? REJECTED_DIR_NAME : KEEP_DIR_NAME;
        const targetDir = verifyCurationDirectory(targetDirName);
        const movedName = lastDecision.movedAs || path.basename(lastDecision.file);
        const sourcePath = path.join(targetDir, movedName);
        if (fs.existsSync(sourcePath)) {
          fs.renameSync(sourcePath, safeJoin(state.folder, lastDecision.file));
        }
      }
      const progress = loadProgress();
      delete progress.reviewed[lastDecision.file];
      saveProgress(progress);
      state.queue.unshift(lastDecision.file);
      return json(res, 200, { ok: true, file: lastDecision.file });
    }

    // --- reset progress (forget reviews; does NOT restore rejected files) ---
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      saveProgress({ reviewed: {} });
      const info = scanFolder();
      return json(res, 200, { ok: true, ...info });
    }

    // --- video stream ---
    if (req.method === 'GET' && url.pathname === '/video') {
      if (activeVideoStreams >= 5) {
        return json(res, 503, { error: 'Too many concurrent video streams' });
      }
      activeVideoStreams++;
      res.on('close', () => {
        activeVideoStreams = Math.max(0, activeVideoStreams - 1);
      });
      return streamVideo(req, res, url.searchParams.get('f') || '');
    }

    json(res, 404, { error: 'not found' });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 500) console.error(error);
    json(res, statusCode, { error: statusCode === 500 ? 'internal error' : error.message });
  }
});

let fallbackAttempted = false;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    if (PORT === 4321 && !fallbackAttempted) {
      fallbackAttempted = true;
      PORT = 4322;
      const warnMsg = `Caution: Port 4321 is already in use. There might be a zombie instance of this application already running. Trying fallback port 4322...`;
      console.warn(warnMsg);
      showNativeErrorDialog(warnMsg, 'Zombie Instance Warning');
      server.listen(PORT, '127.0.0.1', onListening);
      return;
    }
    if (PORT === 4322) {
      const errorMsg = `Security Exception: Port 4322 is already in use. Please close out the dead processes first.`;
      console.error(errorMsg);
      showNativeErrorDialog(errorMsg, 'Port Conflict');
      throw new Error(errorMsg);
    }
    const errorMsg = `Security Exception: Port ${PORT} is already in use.`;
    console.error(errorMsg);
    showNativeErrorDialog(errorMsg, 'Port Conflict');
    throw new Error(errorMsg);
  }
  console.error(err);
  throw err;
});

const BANNED_PORTS = new Set([80, 8080, 443, 8443]);
if (BANNED_PORTS.has(PORT)) {
  const errorMsg = `Security Exception: Port ${PORT} is prohibited.`;
  console.error(errorMsg);
  showNativeErrorDialog(errorMsg, 'Security Violation');
  throw new Error(errorMsg);
}

server.maxConnections = 100;
// keepAliveTimeout must comfortably exceed the client's 3s heartbeat
// interval (see app.js) — otherwise the server can close a pooled
// keep-alive socket just as the browser reuses it, which surfaces to
// fetch() as "Failed to fetch" (ECONNRESET). headersTimeout is kept above
// keepAliveTimeout, as Node recommends, to leave room for a reused
// connection's next request headers to arrive.
server.keepAliveTimeout = 8000;
server.headersTimeout = 9000;
server.requestTimeout = 30000;

if (state.folder) {
  try {
    state.folder = validateFolderPath(state.folder);
  } catch (err) {
    const errorMsg = `Invalid folder path: ${err.message}`;
    console.error(errorMsg.replace(/[\r\n]+/g, ' '));
    showNativeErrorDialog(errorMsg, 'Configuration Error');
    throw err;
  }
  if (!fs.existsSync(state.folder) || !fs.statSync(state.folder).isDirectory()) {
    const errorMsg = `Not a folder: ${state.folder}`;
    console.error(errorMsg.replace(/[\r\n]+/g, ' '));
    showNativeErrorDialog(errorMsg, 'Configuration Error');
    throw new Error(errorMsg);
  }
  const info = scanFolder();
  const sanitizedFolderLog = String(state.folder).replace(/[\r\n]+/g, ' ');
  console.log(`Folder: ${sanitizedFolderLog} (${info.remaining} to review, ${info.reviewed} already done)`);
}

// Remove the progress file whenever the process exits (ping-timeout shutdown,
// browser close, Ctrl+C). The exit handler is the cross-platform path; SIGTERM
// is a no-op on Windows but harmless to listen for.
process.on('exit', cleanupProgress);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

function onListening() {
  const addr = server.address();
  if (!addr || (addr.address !== '127.0.0.1' && addr.address !== '::1')) {
    const errorMsg = `Security Exception: Server is running on a non-loopback interface (${addr ? addr.address : 'unknown'}). Refusing to start.`;
    console.error(errorMsg);
    showNativeErrorDialog(errorMsg, 'Security Violation');
    throw new Error(errorMsg);
  }
  console.log(`Video Curator running at http://localhost:${PORT}`);
  if (!state.folder) console.log('No folder given - enter one in the browser page.');
}

server.listen(PORT, '127.0.0.1', onListening);
