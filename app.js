const player = document.getElementById('player');
const message = document.getElementById('message');
const msgTitle = document.getElementById('msg-title');
const msgBody = document.getElementById('msg-body');
const folderForm = document.getElementById('folder-form');
const folderInput = document.getElementById('folder-input');
const filenameEl = document.getElementById('filename');
const counterEl = document.getElementById('counter');
const keepButton = document.getElementById('btn-keep');
const rejectButton = document.getElementById('btn-reject');
const undoButton = document.getElementById('btn-undo');
const muteButton = document.getElementById('btn-mute');
const muteLabel = document.getElementById('mute-label');
const flash = document.getElementById('flash');
const browseButton = document.getElementById('btn-browse');
const btnKeep = keepButton;
const btnReject = rejectButton;
const btnUndo = undoButton;
const btnMute = muteButton;
const btnBrowse = browseButton;
const themeMeta = document.querySelector('meta[name="theme-color"]');
const themeButtons = document.querySelectorAll('.theme-btn');

const THEME_COLORS = {
  dark: '#0B0B0B',
  grey: '#D6D3CD',
  light: '#F5F3EE',
};

let current = null;
let busy = false;

/**
 * Applies the specified color theme to the user interface.
 * @param {string} theme - Chosen theme identifier ('dark', 'grey', or 'light').
 * @returns {void}
 */
function applyTheme(theme) {
  const chosen = (theme === 'grey' || theme === 'light') ? theme : 'dark';
  document.documentElement.setAttribute('data-theme', chosen);
  if (themeMeta) {
    themeMeta.setAttribute('content', THEME_COLORS[chosen] || '#0B0B0B');
  }
  try {
    localStorage.setItem('video-curator-theme', chosen);
  } catch (error) {
    console.debug('Could not persist theme to localStorage:', error);
  }
  themeButtons.forEach((themeButton) => {
    themeButton.classList.toggle('active', themeButton.getAttribute('data-theme-choice') === chosen);
  });
}

themeButtons.forEach((themeButton) => {
  themeButton.addEventListener('click', () => {
    applyTheme(themeButton.getAttribute('data-theme-choice'));
  });
});

let savedTheme = 'dark';
try {
  savedTheme = localStorage.getItem('video-curator-theme') || 'dark';
} catch (error) {
  console.debug('Could not read theme from localStorage:', error);
}
applyTheme(savedTheme);

/**
 * Displays an informational or error message in the triage card.
 * @param {string} title - Heading text for the message.
 * @param {string} body - Explanatory body text.
 * @param {boolean} [showForm=false] - Whether to display the folder input form.
 * @returns {void}
 */
function showMessage(title, body, showForm = false) {
  player.classList.add('hidden');
  player.pause();
  message.classList.remove('hidden');
  msgTitle.textContent = title;
  msgBody.className = '';
  msgBody.textContent = body;
  folderForm.style.display = showForm ? 'flex' : 'none';
  if (showForm) folderInput.focus();
}

/**
 * Displays a temporary visual action banner indicating the decision.
 * @param {'keep'|'reject'} action - Applied triage decision.
 * @returns {void}
 */
function showFlash(action) {
  flash.textContent = action === 'keep' ? 'KEPT' : 'REJECTED';
  flash.className = 'show ' + action;
  setTimeout(() => flash.classList.remove('show'), 350);
}

/**
 * Updates review statistics and undo button state in the header HUD.
 * @param {{remaining: number, reviewed: number, canUndo: boolean}} status - Current curation status.
 * @returns {void}
 */
function updateHud(status) {
  const total = status.remaining + status.reviewed;
  counterEl.textContent = `${status.reviewed} reviewed | ${status.remaining} left of ${total}`;
  btnUndo.disabled = !status.canUndo;
}

/**
 * Sends an authenticated JSON request to the curation API.
 * @param {string} path - Target API endpoint path.
 * @param {object} [body] - Optional request body for POST requests.
 * @returns {Promise<object>} Parsed response data.
 */
async function sendApiRequest(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (window.API_TOKEN) {
    headers['X-API-Token'] = window.API_TOKEN;
  }
  const response = await fetch(path, body
    ? { method: 'POST', headers, body: JSON.stringify(body) }
    : undefined);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}
const api = sendApiRequest;

/**
 * Fetches and displays the next video file in the curation queue.
 * @returns {Promise<void>}
 */
async function loadNextVideo() {
  const status = await api('/api/next');
  updateHud(status);
  current = status.file;
  if (!current) {
    filenameEl.textContent = '';
    if (status.reviewed > 0) {
      showMessage(
        'All done',
        'Every video in this folder has been reviewed. Kept videos are in the _keep subfolder; rejected ones are in the _rejected subfolder.'
      );
    } else {
      showMessage(
        'No videos found',
        'No video files were found in this folder. Please choose a folder containing videos.',
        true
      );
    }
    return;
  }
  filenameEl.textContent = current;
  message.classList.add('hidden');
  player.classList.remove('hidden');
  player.src = '/video?f=' + encodeURIComponent(current);
  player.play().catch((error) => {
    console.debug('Autoplay prevented or interrupted:', error);
  });
}
const loadNext = loadNextVideo;

/**
 * Submits a keep or reject triage decision for the current video.
 * @param {'keep'|'reject'} action - Triage decision to apply.
 * @returns {Promise<void>}
 */
async function submitDecision(action) {
  if (!current || busy) return;
  busy = true;
  try {
    showFlash(action);
    await api('/api/decide', { file: current, action });
    await loadNext();
  } catch (error) {
    alert(error.message);
  } finally {
    busy = false;
  }
}
const decide = submitDecision;

/**
 * Undoes the most recent triage decision and restores the video to the queue.
 * @returns {Promise<void>}
 */
async function undoLastDecision() {
  if (busy || undoButton.disabled) return;
  busy = true;
  try {
    await api('/api/undo', {});
    await loadNext();
  } catch (error) {
    alert(error.message);
  } finally {
    busy = false;
  }
}
const undo = undoLastDecision;

/**
 * Updates the mute button text based on the player's muted state.
 * @returns {void}
 */
function updateMuteButton() {
  muteLabel.textContent = player.muted ? 'Unmute' : 'Mute';
}

/**
 * Toggles audio playback muting and refreshes the button label.
 * @returns {void}
 */
function toggleMute() {
  player.muted = !player.muted;
  updateMuteButton();
}

updateMuteButton();

keepButton.addEventListener('click', () => decide('keep'));
rejectButton.addEventListener('click', () => decide('reject'));
undoButton.addEventListener('click', undo);
muteButton.addEventListener('click', toggleMute);

player.addEventListener('error', () => {
  if (!current) return;
  filenameEl.textContent = current + ' (cannot play in browser; keep or reject by filename, or undo)';
});

// Reaching the end without a decision counts as Keep.
player.addEventListener('ended', () => decide('keep'));

browseButton.addEventListener('click', async () => {
  browseButton.disabled = true;
  browseButton.textContent = 'Browsing...';
  try {
    const browseResult = await api('/api/browse', {});
    if (browseResult.folder) {
      folderInput.value = browseResult.folder;
      const startButton = folderForm.querySelector('button[type="submit"]');
      if (startButton) startButton.focus();
    }
  } catch (error) {
    msgTitle.textContent = 'Error';
    msgBody.className = 'error-text';
    msgBody.textContent = error.message;
    folderForm.style.display = 'flex';
  } finally {
    browseButton.disabled = false;
    browseButton.textContent = 'Browse';
  }
});

folderForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const folder = folderInput.value.trim();
  if (!folder) return;
  try {
    await api('/api/folder', { folder });
    await loadNext();
  } catch (error) {
    msgTitle.textContent = 'Invalid Path';
    msgBody.className = 'error-text';
    msgBody.textContent = error.message;
    folderForm.style.display = 'flex';
  }
});

document.addEventListener('keydown', (event) => {
  if (event.target === folderInput) return;
  switch (event.key.toLowerCase()) {
    case 'k': case 'arrowright': event.preventDefault(); decide('keep'); break;
    case 'r': case 'arrowleft': event.preventDefault(); decide('reject'); break;
    case 'u': event.preventDefault(); undo(); break;
    case 'm': event.preventDefault(); toggleMute(); break;
    case ' ':
      event.preventDefault();
      player.paused ? player.play() : player.pause();
      break;
  }
});

// Keep-alive: ping while open so the server knows we're here; a close beacon
// tells it to shut down promptly.
setInterval(() => {
  fetch('/api/ping').catch((error) => {
    console.debug('Keepalive ping failed:', error);
  });
}, 3000);
window.addEventListener('pagehide', () => {
  const token = window.API_TOKEN ? '?t=' + encodeURIComponent(window.API_TOKEN) : '';
  navigator.sendBeacon('/api/bye' + token);
});

(async function init() {
  try {
    const status = await api('/api/status');
    if (!status.folder) {
      showMessage('Choose a folder', 'Paste the full path of the folder containing your videos.', true);
      return;
    }
    updateHud(status);
    await loadNext();
  } catch (error) {
    showMessage('Error', error.message, true);
  }
})();
