// Video Curator - zero-dependency local server
// Usage: node server.js ["C:\path\to\videos"] [port]

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const net = require('net');
const os = require('os');

const PORT = Number(process.argv[3]) || 4321;
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
  const escapedMessage = message.replace(/"/g, '\\"');
  const escapedTitle = title.replace(/"/g, '\\"');

  try {
    if (process.platform === 'win32') {
      const cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${escapedMessage.replace(/'/g, "''")}', '${escapedTitle.replace(/'/g, "''")}', 0, 16)"`;
      execSync(cmd, { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      const cmd = `osascript -e "display dialog \\"${escapedMessage}\\" with title \\"${escapedTitle}\\" buttons {\\"OK\\"} default button 1 with icon stop"`;
      execSync(cmd, { stdio: 'ignore' });
    } else {
      try {
        const cmd = `zenity --error --title="${escapedTitle}" --text="${escapedMessage}"`;
        execSync(cmd, { stdio: 'ignore' });
      } catch (err) {
        try {
          const cmd = `kdialog --error "${escapedMessage}" --title "${escapedTitle}"`;
          execSync(cmd, { stdio: 'ignore' });
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
      const cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select Video Folder'; $f.ShowNewFolderButton = $false; $r = $f.ShowDialog(); if ($r -eq 'OK') { Write-Output $f.SelectedPath }"`;
      exec(cmd, (error, stdout) => {
        if (error) {
          return reject(new Error('Failed to open directory dialog: ' + error.message));
        }
        resolve(stdout.trim() || null);
      });
    } else if (process.platform === 'darwin') {
      const cmd = `osascript -e "POSIX path of (choose folder with prompt \\"Select a folder containing your videos\\")"`;
      exec(cmd, (error, stdout) => {
        if (error) {
          if (error.message.includes('User canceled')) {
            return resolve(null);
          }
          return reject(new Error('Failed to open directory dialog: ' + error.message));
        }
        resolve(stdout.trim() || null);
      });
    } else {
      const cmd = `zenity --file-selection --directory --title="Select a folder containing your videos"`;
      exec(cmd, (error, stdout) => {
        if (error) {
          const fallbackCmd = `kdialog --getexistingdirectory`;
          exec(fallbackCmd, (fbError, fbStdout) => {
            if (fbError) {
              return resolve(null);
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

  const resolved = path.resolve(rawPath);

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
  try {
    return JSON.parse(fs.readFileSync(progressPath(), 'utf8'));
  } catch {
    return { reviewed: {} };
  }
}

function saveProgress(progress) {
  fs.writeFileSync(progressPath(), JSON.stringify(progress, null, 2));
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
  try { filePath = safeJoin(state.folder, filename); } catch { return json(res, 400, { error: 'bad path' }); }
  if (!fs.existsSync(filePath)) return json(res, 404, { error: 'not found' });

  const stats = fs.statSync(filePath);
  const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  const rangeMatch = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;

  if (rangeMatch && (rangeMatch[1] || rangeMatch[2])) {
    let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
    let end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : stats.size - 1;
    if (start > end || start >= stats.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
      return res.end();
    }
    end = Math.min(end, stats.size - 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stats.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stats.size,
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
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
    // --- static assets ---
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
        const targetDir = path.join(state.folder, targetDirName);
        fs.mkdirSync(targetDir, { recursive: true });
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
        const movedName = lastDecision.movedAs || path.basename(lastDecision.file);
        const sourcePath = path.join(state.folder, targetDirName, movedName);
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
      return streamVideo(req, res, url.searchParams.get('f') || '');
    }

    json(res, 404, { error: 'not found' });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 500) console.error(error);
    json(res, statusCode, { error: statusCode === 500 ? 'internal error' : error.message });
  }
});

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

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  if (!addr || (addr.address !== '127.0.0.1' && addr.address !== '::1')) {
    const errorMsg = `Security Exception: Server is running on a non-loopback interface (${addr ? addr.address : 'unknown'}). Refusing to start.`;
    console.error(errorMsg);
    showNativeErrorDialog(errorMsg, 'Security Violation');
    throw new Error(errorMsg);
  }
  console.log(`Video Curator running at http://localhost:${PORT}`);
  if (!state.folder) console.log('No folder given - enter one in the browser page.');
});
