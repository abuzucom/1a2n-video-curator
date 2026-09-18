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

const PROTOCOL_URL_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const RANGE_HEADER_REGEX = /bytes=(\d*)-(\d*)/;
const EXTENDED_PICTOGRAPHIC_REGEX = /\p{Extended_Pictographic}/u;
const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F-\x9F]/;
const BOX_DRAWING_REGEX = /[\u2500-\u259F]/;
const BEARER_AUTH_REGEX = /^Bearer\s+/i;
const NEWLINE_SPLIT_REGEX = /\r?\n/;
const WHITESPACE_SPLIT_REGEX = /\s+/;
const PATH_SEPARATOR_SPLIT_REGEX = /[/\\]/;
const TRAILING_SLASH_REGEX = /[/\\]$/;
const LINEBREAK_NORMALIZE_REGEX = /[\r\n]+/g;

const staticAssetCache = new Map();
let cachedIndexHtmlBuffer = null;
let cachedProhibitedDirectories = null;

let allowedOrigins = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  `http://[::1]:${PORT}`
]);

/**
 * Refreshes the set of allowed origins when the listening port changes.
 * @returns {void}
 */
function refreshAllowedOrigins() {
  allowedOrigins = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://[::1]:${PORT}`
  ]);
}

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
  '/':                            ['index.html',                   'text/html; charset=utf-8'],
  '/styles.css':                  ['styles.css',                  'text/css; charset=utf-8'],
  '/app.js':                      ['app.js',                      'text/javascript; charset=utf-8'],
  '/fonts/LibreFranklin.woff2':   ['fonts/LibreFranklin.woff2',   'font/woff2'],
  '/fonts/Cousine-Regular.woff2': ['fonts/Cousine-Regular.woff2', 'font/woff2'],
  '/fonts/Cousine-Bold.woff2':    ['fonts/Cousine-Bold.woff2',    'font/woff2'],
};

/**
 * Checks whether graphical desktop capabilities are available in the current environment.
 * @returns {boolean} True if a GUI session is available.
 */
function isGuiAvailable() {
  if (process.env.TESTING) return false;
  if (process.platform === 'win32') {
    const session = process.env.SESSIONNAME;
    return !(session && session.toLowerCase().startsWith('services'));
  }
  return process.platform === 'darwin' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Displays a native graphical error dialog for critical startup errors.
 * @param {string} message - Error message text to display.
 * @param {string} [title='Security Error'] - Window title for the dialog.
 * @returns {void}
 */
function showNativeErrorDialog(message, title = 'Security Error') {
  if (!isGuiAvailable()) return;

  try {
    const env = {
      ...process.env,
      DIALOG_MSG: message,
      DIALOG_TITLE: title
    };

    if (process.platform === 'win32') {
      // A TopMost owner form is required so the dialog comes to the
      // foreground instead of opening behind the browser window: Node has
      // no window of its own, so Windows' focus-stealing prevention
      // otherwise leaves it stuck behind the active window (same issue
      // fixed for the folder-picker dialog below).
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; $owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; [System.Windows.Forms.MessageBox]::Show($owner, $env:DIALOG_MSG, $env:DIALOG_TITLE, 0, 16); $owner.Dispose()'
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
      } catch (error) {
        try {
          execFileSync('kdialog', [
            '--error',
            message,
            '--title',
            title
          ], { stdio: 'ignore' });
        } catch (fallbackError) {
          console.debug('Fallback kdialog error dialog failed:', fallbackError.message);
        }
      }
    }
  } catch (error) {
    console.error(`Fallback console error [${title}]: ${message}`);
  }
}

// Best-effort cleanup of a previous, still-running instance of this exact
// server.js (e.g. one left over from a crashed browser tab or a hung
// folder dialog) so a fresh launch doesn't get bounced to the fallback
// port just because a zombie is squatting on 4321. Matches only processes
// whose command line contains this file's own path, and never the current
// process, so it can't touch an unrelated Node app on the machine. The
// script path and current PID are passed via environment variables rather
// than interpolated into the command string, same precaution used for
// showNativeErrorDialog's dialog text.
/**
 * Terminates previous zombie instances of the server process on Windows.
 * @returns {void}
 */
function killStaleWindowsInstances() {
  if (process.platform !== 'win32' || process.env.TESTING) return;
  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ' +
      'Where-Object { $_.ProcessId -ne [int]$env:VC_CURRENT_PID -and $_.CommandLine -like ("*" + $env:VC_SCRIPT_PATH + "*") } | ' +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
    ], {
      stdio: 'ignore',
      env: { ...process.env, VC_SCRIPT_PATH: __filename, VC_CURRENT_PID: String(process.pid) },
    });
  } catch (err) {
    // Best-effort cleanup of stale Windows instances.
    console.debug('killStaleWindowsInstances failed:', err.message);
  }
}

// Cap how long a folder dialog can stay open. Without this, a hung dialog
// process (AV interference, an owner form that never disposes, etc.) would
// leave its promise unsettled forever, which permanently suppresses the
// idle-shutdown watchdog (see openDialogs) and turns the server itself into
// the kind of orphaned "zombie instance" it warns about elsewhere.
const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Launches the default web browser pointing to the server URL.
 * @param {string} url - Target URL to open in the browser.
 * @returns {void}
 */
function openBrowser(url) {
  if (!isGuiAvailable()) return;
  // execFile's callback is required here even though we ignore success: with
  // no callback, a failed spawn (e.g. a missing xdg-open) emits an unhandled
  // 'error' event on the returned ChildProcess, which crashes the process.
  const onOpenError = (err) => {
    if (err) console.error(`Could not open browser automatically: ${err.message}`);
  };
  if (process.platform === 'win32') {
    execFile('cmd.exe', ['/c', 'start', '', url], onOpenError);
  } else if (process.platform === 'darwin') {
    execFile('open', [url], onOpenError);
  } else {
    execFile('xdg-open', [url], onOpenError);
  }
}

/**
 * Displays a native operating system folder selection dialog.
 * @returns {Promise<string|null>} Selected folder path or null if canceled.
 */
function showNativeFolderPicker() {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child = null;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child) child.kill();
      reject(new Error('Folder dialog timed out waiting for a selection.'));
    }, DIALOG_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    /**
     * Finalizes the folder picker promise and clears the timeout timer.
     * @param {Function} settlePromise - Settlement function (resolve or reject).
     * @param {*} value - Settlement value or error.
     * @returns {void}
     */
    function finish(settlePromise, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settlePromise(value);
    }

    if (process.platform === 'win32') {
      const psScript = [
        'try {',
        '  Add-Type -AssemblyName System.Windows.Forms;',
        '  [System.Windows.Forms.Application]::EnableVisualStyles();',
        '  $owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true};',
        '  $f = New-Object System.Windows.Forms.FolderBrowserDialog;',
        '  $f.Description = \'Select Video Folder\';',
        '  $f.ShowNewFolderButton = $false;',
        '  $r = $f.ShowDialog($owner);',
        '  $owner.Dispose();',
        '  if ($r -eq \'OK\') { Write-Output $f.SelectedPath }',
        '} catch {',
        '  Write-Error $_.Exception.Message;',
        '  exit 1',
        '}',
      ].join(' ');

      child = execFile('powershell.exe', [
        '-NoProfile',
        '-Sta',
        '-Command',
        psScript,
      ], (error, stdout, stderr) => {
        if (error) {
          return finish(reject, new Error('Failed to open directory dialog: ' + (stderr ? stderr.trim() : error.message)));
        }
        finish(resolve, stdout.trim() || null);
      });
    } else if (process.platform === 'darwin') {
      child = execFile('osascript', [
        '-e',
        'POSIX path of (choose folder with prompt "Select a folder containing your videos")'
      ], (error, stdout) => {
        if (error) {
          if (error.message.includes('User canceled')) {
            return finish(resolve, null);
          }
          return finish(reject, new Error('Failed to open directory dialog: ' + error.message));
        }
        finish(resolve, stdout.trim() || null);
      });
    } else {
      child = execFile('zenity', [
        '--file-selection',
        '--directory',
        '--title=Select a folder containing your videos'
      ], (error, stdout) => {
        if (error) {
          if (error.code !== 'ENOENT') {
            return finish(resolve, null); // user canceled the dialog
          }
          child = execFile('kdialog', ['--getexistingdirectory'], (fbError, fbStdout) => {
            if (fbError) {
              if (fbError.code !== 'ENOENT') {
                return finish(resolve, null); // user canceled the dialog
              }
              return finish(reject, new Error(
                'No folder-picker tool found (zenity or kdialog). Install one, or paste the folder path directly.'
              ));
            }
            finish(resolve, fbStdout.trim() || null);
          });
          return;
        }
        finish(resolve, stdout.trim() || null);
      });
    }
  });
}

/**
 * Verifies that localhost entries in the system hosts file map strictly to loopback IP addresses.
 * @returns {void}
 */
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
  const lines = content.split(NEWLINE_SPLIT_REGEX);

  for (const line of lines) {
    const cleanLine = line.split('#')[0].trim();
    if (!cleanLine) continue;

    const parts = cleanLine.split(WHITESPACE_SPLIT_REGEX);
    if (parts.length >= 2) {
      const ipAddress = parts[0];
      const hostnames = parts.slice(1).map(hostname => hostname.toLowerCase());
      if (hostnames.includes('localhost') && ipAddress !== '127.0.0.1' && ipAddress !== '::1') {
        throw new Error(`Security Exception: localhost mapped to non-loopback IP ${ipAddress} in hosts file.`);
      }
    }
  }
}

/**
 * Determines whether a host string represents an IP address or IPv6 literal.
 * @param {string} host - Hostname or address string to evaluate.
 * @returns {boolean} True if host is an IP address.
 */
function isIPAddress(host) {
  const target = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return !!net.isIP(target) || host.toLowerCase().endsWith('.ipv6-literal.net');
}

/**
 * Checks whether a path string contains emojis or prohibited control characters.
 * @param {string} str - String to test for prohibited characters.
 * @returns {boolean} True if prohibited characters are present.
 */
function hasProhibitedCharacters(str) {
  return EXTENDED_PICTOGRAPHIC_REGEX.test(str) ||
    CONTROL_CHARS_REGEX.test(str) ||
    BOX_DRAWING_REGEX.test(str);
}

/**
 * Resolves and caches operating system prohibited directory paths.
 * @returns {string[]} List of prohibited directory paths.
 */
function getProhibitedDirectories() {
  if (cachedProhibitedDirectories) return cachedProhibitedDirectories;
  const dirs = [];
  if (process.platform === 'win32') {
    if (process.env.windir) dirs.push(path.resolve(process.env.windir));
    if (process.env.SystemRoot) dirs.push(path.resolve(process.env.SystemRoot));
    if (process.env.ProgramFiles) dirs.push(path.resolve(process.env.ProgramFiles));
    if (process.env['ProgramFiles(x86)']) dirs.push(path.resolve(process.env['ProgramFiles(x86)']));
    if (process.env.ProgramData) dirs.push(path.resolve(process.env.ProgramData));
    if (process.env.APPDATA) dirs.push(path.resolve(process.env.APPDATA));
    if (process.env.LOCALAPPDATA) dirs.push(path.resolve(process.env.LOCALAPPDATA));
    if (process.env.USERPROFILE) dirs.push(path.resolve(path.join(process.env.USERPROFILE, 'AppData')));

    dirs.push('C:\\Windows');
    dirs.push('C:\\Program Files');
    dirs.push('C:\\Program Files (x86)');
    dirs.push('C:\\ProgramData');
  } else {
    dirs.push('/boot', '/etc', '/root', '/proc', '/sys');
  }
  cachedProhibitedDirectories = dirs;
  return cachedProhibitedDirectories;
}

/**
 * Validates and canonicalizes a video curation folder path.
 * @param {string} folderPath - Raw folder path input.
 * @returns {string} Canonicalized absolute directory path.
 */
function validateFolderPath(folderPath) {
  if (!folderPath) {
    throw new Error('Path is required.');
  }

  const rawPath = String(folderPath).trim();

  if (PROTOCOL_URL_REGEX.test(rawPath)) {
    throw new Error('Web URLs or protocols are not allowed.');
  }

  const ext = path.extname(rawPath);
  if (ext && ext.length > 1) {
    throw new Error('Paths with file extensions are not allowed. Please select a folder.');
  }

  if (hasProhibitedCharacters(rawPath)) {
    throw new Error('The selected path contains prohibited characters (emojis or invalid symbols).');
  }

  const isNetworkPath = rawPath.startsWith('\\\\') || rawPath.startsWith('//');
  if (isNetworkPath) {
    const hostSegment = rawPath.substring(2).split(PATH_SEPARATOR_SPLIT_REGEX)[0];
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
    // Best-effort symlink canonicalization.
    // Fall back to the non-canonicalized path.
    console.debug('realpath resolution skipped:', err.message);
  }

  const prohibitedDirs = getProhibitedDirectories();
  if (process.platform === 'win32') {
    const normalizedResolved = resolved.toLowerCase().replace(TRAILING_SLASH_REGEX, '');

    for (const dir of prohibitedDirs) {
      const normalizedDir = dir.toLowerCase();
      if (normalizedResolved === normalizedDir || normalizedResolved.startsWith(normalizedDir + '\\') || normalizedResolved.startsWith(normalizedDir + '/')) {
        throw new Error(`Access to Windows system directory ${dir} is prohibited.`);
      }
    }
  } else {
    const normalizedResolved = resolved === '/' ? '/' : resolved.replace(TRAILING_SLASH_REGEX, '');

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
  reviewedCount: 0, // in-memory count of reviewed videos
};

let activeVideoStreams = 0;
const rateLimitStore = {};

/**
 * Applies a sliding-window rate limit to an operation key.
 * @param {string} key - Rate limit identifier.
 * @param {number} limit - Maximum allowed requests within the window.
 * @param {number} windowMs - Window duration in milliseconds.
 * @returns {boolean} True if request is within limits.
 */
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const timestamps = (rateLimitStore[key] || []).filter(timestamp => now - timestamp < windowMs);
  rateLimitStore[key] = timestamps;
  if (timestamps.length >= limit) return false;
  timestamps.push(now);
  return true;
}

let lastSeen = 0;
let watchdog = null;
// Native folder dialogs steal OS focus from the browser tab, and background
// tabs get their setInterval heartbeat throttled by the browser — so the
// ping can legitimately stall past IDLE_SHUTDOWN_MS while the user is just
// browsing folders. Suppress the watchdog while a dialog is open so the
// server isn't mistaken for an abandoned tab and killed mid-pick.
let openDialogs = 0;

/**
 * Updates the last-seen heartbeat timestamp and starts the idle shutdown watchdog.
 * @param {boolean} [soon=false] - If true, shortens grace period for prompt shutdown.
 * @returns {void}
 */
function recordHeartbeat(soon = false) {
  lastSeen = soon ? Date.now() - (IDLE_SHUTDOWN_MS - 3000) : Date.now();
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (openDialogs > 0) return;
    if (Date.now() - lastSeen > IDLE_SHUTDOWN_MS) {
      console.log('Browser closed — shutting down.');
      process.exit(0);
    }
  }, 2000);
  if (watchdog.unref) watchdog.unref();
}
const touch = recordHeartbeat;

/**
 * Resolves the path to the curation progress file in the active folder.
 * @returns {string} Absolute path to the progress file.
 */
function getProgressFilePath() {
  return path.join(state.folder, PROGRESS_FILE);
}
const progressPath = getProgressFilePath;

/**
 * Loads and parses curation progress from disk.
 * @returns {{reviewed: Record<string, string>}} Curation progress object.
 */
function loadProgress() {
  const target = progressPath();
  const targetDir = path.dirname(path.resolve(target));
  const expectedDir = path.resolve(state.folder);
  if (targetDir !== expectedDir) {
    throw new Error('Security Exception: Target directory mismatch.');
  }

  try {
    const fileStats = fs.lstatSync(target);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      throw new Error('Security Exception: Target path is a symbolic link or non-regular file.');
    }
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.message.includes('Security Exception')) {
      throw error;
    }
    return { reviewed: {} };
  }
}

/**
 * Atomically writes curation progress to disk using a temporary file.
 * @param {{reviewed: Record<string, string>}} progress - Curation progress object.
 * @returns {void}
 */
function saveProgress(progress) {
  const target = progressPath();
  const targetDir = path.dirname(path.resolve(target));
  const expectedDir = path.resolve(state.folder);
  if (targetDir !== expectedDir) {
    throw new Error('Security Exception: Target directory mismatch.');
  }

  try {
    const fileStats = fs.lstatSync(target);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      throw new Error('Security Exception: Target path is a symbolic link or non-regular file.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const tmpPath = target + '.tmp';
  const tmpDir = path.dirname(path.resolve(tmpPath));
  if (tmpDir !== expectedDir) {
    throw new Error('Security Exception: Target directory mismatch.');
  }

  try {
    const tmpStats = fs.lstatSync(tmpPath);
    if (tmpStats.isSymbolicLink() || !tmpStats.isFile()) {
      fs.unlinkSync(tmpPath);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  fs.writeFileSync(tmpPath, JSON.stringify(progress, null, 2));
  fs.renameSync(tmpPath, target);
}

// Delete the session's progress file on shutdown. Constrained to exactly that
// one file inside the chosen folder: never a directory, symlink, or video.
/**
 * Deletes the session's progress file on server shutdown.
 * @returns {void}
 */
function cleanupProgress() {
  const folder = state.folder;
  if (!folder) return;
  const target = path.join(folder, PROGRESS_FILE);
  if (path.basename(target) !== PROGRESS_FILE) return;                       // exact name
  if (path.dirname(path.resolve(target)) !== path.resolve(folder)) return;   // inside folder only
  try {
    const fileStats = fs.lstatSync(target);   // lstat: never follow a symlink
    if (!fileStats.isFile()) return;          // never a directory/symlink/device
    fs.unlinkSync(target);             // one file only, never recursive
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.debug('Failed to remove progress file:', error.message);
    }
  }
}

/**
 * Validates request authenticity using API tokens and origin headers.
 * @param {http.IncomingMessage} req - Incoming HTTP request.
 * @param {URL} url - Parsed request URL.
 * @returns {void}
 */
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
    let refUrl;
    try {
      refUrl = new URL(referer);
    } catch (err) {
      throw new Error('Invalid Referer: ' + err.message);
    }
    const refOrigin = `${refUrl.protocol}//${refUrl.host}`;
    if (!allowedOrigins.has(refOrigin)) {
      throw new Error('Forbidden Referer');
    }
  }
}

/**
 * Verifies directory confinement and creates target curation directories.
 * @param {string} dirName - Relative directory name ('_keep' or '_rejected').
 * @returns {string} Canonical path to the verified curation directory.
 */
function verifyCurationDirectory(dirName) {
  const dirPath = path.join(state.folder, dirName);
  const resolvedBase = path.resolve(state.folder);
  const resolvedTarget = path.resolve(dirPath);
  const relativeCheck = path.relative(resolvedBase, resolvedTarget);
  if (relativeCheck !== dirName || path.isAbsolute(relativeCheck)) {
    throw new Error(`Security Exception: Directory '${dirName}' resolved outside the folder tree.`);
  }

  try {
    const dirStats = fs.lstatSync(dirPath);
    if (dirStats.isSymbolicLink()) {
      throw new Error(`Security Exception: Directory '${dirName}' is a symbolic link.`);
    }
    if (!dirStats.isDirectory()) {
      throw new Error(`Security Exception: Path '${dirName}' is not a directory.`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      fs.mkdirSync(dirPath, { recursive: true });
    } else {
      throw error;
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

/**
 * Shuffles elements of an array in place using the Fisher-Yates algorithm.
 * @template T
 * @param {T[]} items - Array of items to shuffle.
 * @returns {T[]} The shuffled array.
 */
function shuffleArray(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
const shuffle = shuffleArray;

// Scan folder, drop already-reviewed files, shuffle the rest into the queue.
/**
 * Scans the active folder for unreviewed videos and populates the triage queue.
 * @returns {{remaining: number, reviewed: number}} Counts of remaining and reviewed files.
 */
function scanFolder() {
  const progress = loadProgress();
  const reviewedSet = new Set(Object.keys(progress.reviewed));
  const files = fs.readdirSync(state.folder, { withFileTypes: true })
    .filter(entry => entry.isFile() && VIDEO_EXTS.has(path.extname(entry.name).toLowerCase()))
    .map(entry => entry.name)
    .filter(name => !reviewedSet.has(name));
  state.queue = shuffle(files);
  state.history = [];
  state.reviewedCount = reviewedSet.size;
  return { remaining: files.length, reviewed: state.reviewedCount };
}

/**
 * Safely joins a directory and filename, preventing directory traversal.
 * @param {string} base - Base directory path.
 * @param {string} name - File name to join.
 * @returns {string} Resolved safe path.
 */
function safeJoin(base, name) {
  const resolvedBase = path.resolve(base);
  const resolvedPath = path.resolve(resolvedBase, path.basename(name));
  const relativePath = path.relative(resolvedBase, resolvedPath);
  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('bad path');
  }
  return resolvedPath;
}

/**
 * Sends an HTTP response with JSON content and the specified status code.
 * @param {http.ServerResponse} res - HTTP response object.
 * @param {number} statusCode - HTTP status code.
 * @param {object} payload - JSON serializable response payload.
 * @returns {void}
 */
function sendJsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}
const json = sendJsonResponse;

/**
 * Reads and parses a JSON request body with maximum byte size limits.
 * @param {http.IncomingMessage} req - Incoming HTTP request.
 * @returns {Promise<object>} Parsed JSON request body.
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const bodyChunks = [];
    let byteCount = 0;
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      byteCount += chunk.length;
      if (byteCount > MAX_BODY_BYTES) {
        aborted = true;
        const error = new Error('body too large');
        error.statusCode = 413;
        return reject(error);
      }
      bodyChunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const rawBody = Buffer.concat(bodyChunks).toString('utf8');
        resolve(rawBody ? JSON.parse(rawBody) : {});
      } catch (error) {
        const parseError = new Error('invalid JSON: ' + error.message);
        parseError.statusCode = 400;
        reject(parseError);
      }
    });
    req.on('error', reject);
  });
}
const readBody = readRequestBody;

/**
 * Streams a video file to the client with HTTP range-request support.
 * @param {http.IncomingMessage} req - Incoming HTTP request.
 * @param {http.ServerResponse} res - Outgoing HTTP response.
 * @param {string} filename - Video file name relative to the active folder.
 * @returns {void}
 */
function streamVideo(req, res, filename) {
  let filePath;
  try {
    filePath = safeJoin(state.folder, filename);
  } catch (error) {
    return json(res, 400, { error: 'bad path: ' + error.message });
  }

  let fileDescriptor;
  try {
    let flags = fs.constants.O_RDONLY;
    if (fs.constants.O_NOFOLLOW) {
      flags |= fs.constants.O_NOFOLLOW;
    }
    fileDescriptor = fs.openSync(filePath, flags);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return json(res, 404, { error: 'not found' });
    }
    return json(res, 400, { error: error.message });
  }

  try {
    const stats = fs.fstatSync(fileDescriptor);
    if (!stats.isFile()) {
      fs.closeSync(fileDescriptor);
      return json(res, 400, { error: 'not a file' });
    }

    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    const rangeMatch = range ? RANGE_HEADER_REGEX.exec(range) : null;

    if (rangeMatch && (rangeMatch[1] || rangeMatch[2])) {
      let start;
      let end;
      if (!rangeMatch[1] && rangeMatch[2]) {
        const suffixLength = parseInt(rangeMatch[2], 10);
        start = Math.max(0, stats.size - suffixLength);
        end = stats.size - 1;
      } else {
        start = parseInt(rangeMatch[1], 10);
        end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : stats.size - 1;
      }

      end = Math.min(end, stats.size - 1);

      if (start > end || start >= stats.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
        fs.closeSync(fileDescriptor);
        return res.end();
      }

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime,
      });
      fs.createReadStream(null, { fd: fileDescriptor, start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stats.size,
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(null, { fd: fileDescriptor }).pipe(res);
    }
  } catch (error) {
    try {
      fs.closeSync(fileDescriptor);
    } catch (closeError) {
      console.debug('Failed to close video file descriptor:', closeError.message);
    }
    return json(res, 500, { error: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    const hostHeader = req.headers.host || 'localhost';
    url = new URL(req.url, `http://${hostHeader}`);
  } catch (err) {
    return json(res, 400, { error: 'bad request' });
  }

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
      if (!cachedIndexHtmlBuffer) {
        let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
        html = html.replace('</head>', `<script>window.API_TOKEN = "${API_TOKEN}";</script>\n</head>`);
        cachedIndexHtmlBuffer = Buffer.from(html, 'utf8');
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': cachedIndexHtmlBuffer.length,
      });
      return res.end(cachedIndexHtmlBuffer);
    }
    const asset = ASSETS[url.pathname];
    if (req.method === 'GET' && asset) {
      let cached = staticAssetCache.get(url.pathname);
      if (!cached) {
        const [file, type] = asset;
        const content = fs.readFileSync(path.join(__dirname, file));
        cached = { content, type };
        staticAssetCache.set(url.pathname, cached);
      }
      const headers = {
        'Content-Type': cached.type,
        'Content-Length': cached.content.length,
      };
      if (url.pathname.startsWith('/fonts/')) {
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      }
      res.writeHead(200, headers);
      return res.end(cached.content);
    }

    // --- set / get folder ---
    if (req.method === 'GET' && url.pathname === '/api/status') {
      if (!state.folder) return json(res, 200, { folder: null });
      return json(res, 200, {
        folder: state.folder,
        remaining: state.queue.length,
        reviewed: state.reviewedCount,
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
      openDialogs++;
      try {
        const folder = await showNativeFolderPicker();
        touch();
        return json(res, 200, { folder: folder ? validateFolderPath(folder) : null });
      } catch (err) {
        return json(res, 400, { error: err.message });
      } finally {
        openDialogs--;
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

    const FOLDER_DEPENDENT_ROUTES = new Set([
      '/api/next',
      '/api/decide',
      '/api/undo',
      '/api/reset',
      '/video',
    ]);
    if (FOLDER_DEPENDENT_ROUTES.has(url.pathname) && !state.folder) {
      return json(res, 400, { error: 'No folder selected' });
    }

    // --- queue ---
    if (req.method === 'GET' && url.pathname === '/api/next') {
      const file = state.queue[0] || null;
      return json(res, 200, {
        file,
        remaining: state.queue.length,
        reviewed: state.reviewedCount,
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
      const targetDirName = action === 'reject' ? REJECTED_DIR_NAME : KEEP_DIR_NAME;
      const targetDir = verifyCurationDirectory(targetDirName);
      const sourcePath = safeJoin(state.folder, file);
      let destPath = path.join(targetDir, path.basename(file));
      // avoid clobbering an existing file with the same name
      let duplicateCount = 1;
      const extension = path.extname(file);
      const baseName = path.basename(file, extension);
      while (fs.existsSync(destPath)) {
        destPath = path.join(targetDir, `${baseName} (${duplicateCount++})${extension}`);
      }
      fs.renameSync(sourcePath, destPath);
      movedAs = path.basename(destPath);

      state.queue.shift();
      state.history.push({ file, action, movedAs });
      const progress = loadProgress();
      progress.reviewed[file] = action;
      saveProgress(progress);
      state.reviewedCount++;
      return json(res, 200, { ok: true, remaining: state.queue.length });
    }

    // --- undo last decision (this session) ---
    if (req.method === 'POST' && url.pathname === '/api/undo') {
      const lastDecision = state.history.pop();
      if (!lastDecision) return json(res, 400, { error: 'Nothing to undo' });

      const targetDirName = lastDecision.action === 'reject' ? REJECTED_DIR_NAME : KEEP_DIR_NAME;
      const targetDir = verifyCurationDirectory(targetDirName);
      const movedName = lastDecision.movedAs || path.basename(lastDecision.file);
      const sourcePath = path.join(targetDir, movedName);
      if (fs.existsSync(sourcePath)) {
        fs.renameSync(sourcePath, safeJoin(state.folder, lastDecision.file));
      }
      const progress = loadProgress();
      delete progress.reviewed[lastDecision.file];
      saveProgress(progress);
      state.reviewedCount = Math.max(0, state.reviewedCount - 1);
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
      refreshAllowedOrigins();
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
    console.error(errorMsg.replace(LINEBREAK_NORMALIZE_REGEX, ' '));
    showNativeErrorDialog(errorMsg, 'Configuration Error');
    throw err;
  }
  if (!fs.existsSync(state.folder) || !fs.statSync(state.folder).isDirectory()) {
    const errorMsg = `Not a folder: ${state.folder}`;
    console.error(errorMsg.replace(LINEBREAK_NORMALIZE_REGEX, ' '));
    showNativeErrorDialog(errorMsg, 'Configuration Error');
    throw new Error(errorMsg);
  }
  const info = scanFolder();
  const sanitizedFolderLog = String(state.folder).replace(LINEBREAK_NORMALIZE_REGEX, ' ');
  console.log(`Folder: ${sanitizedFolderLog} (${info.remaining} to review, ${info.reviewed} already done)`);
}

// Remove the progress file whenever the process exits (ping-timeout shutdown,
// browser close, Ctrl+C). The exit handler is the cross-platform path; SIGTERM
// is a no-op on Windows but harmless to listen for.
process.on('exit', cleanupProgress);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

/**
 * Handles the HTTP server listening event, validating loopback binding and opening the browser.
 * @returns {void}
 */
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
  openBrowser(`http://localhost:${PORT}`);
}

killStaleWindowsInstances();
server.listen(PORT, '127.0.0.1', onListening);
