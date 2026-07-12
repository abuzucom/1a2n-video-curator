const player = document.getElementById('player');
const message = document.getElementById('message');
const msgTitle = document.getElementById('msg-title');
const msgBody = document.getElementById('msg-body');
const folderForm = document.getElementById('folder-form');
const folderInput = document.getElementById('folder-input');
const filenameEl = document.getElementById('filename');
const counterEl = document.getElementById('counter');
const btnKeep = document.getElementById('btn-keep');
const btnReject = document.getElementById('btn-reject');
const btnUndo = document.getElementById('btn-undo');
const btnMute = document.getElementById('btn-mute');
const muteLabel = document.getElementById('mute-label');
const flash = document.getElementById('flash');
const btnBrowse = document.getElementById('btn-browse');

let current = null;
let busy = false;

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

function showFlash(action) {
  flash.textContent = action === 'keep' ? 'KEPT' : 'REJECTED';
  flash.className = 'show ' + action;
  setTimeout(() => flash.classList.remove('show'), 350);
}

function updateHud(status) {
  const total = status.remaining + status.reviewed;
  counterEl.textContent = `${status.reviewed} reviewed · ${status.remaining} left of ${total}`;
  btnUndo.disabled = !status.canUndo;
}

async function api(path, body) {
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

async function loadNext() {
  const status = await api('/api/next');
  updateHud(status);
  current = status.file;
  if (!current) {
    filenameEl.textContent = '';
    showMessage('All done \u{1F389}', 'Every video in this folder has been reviewed. Kept videos are in the _keep subfolder; rejected ones are in the _rejected subfolder.');
    return;
  }
  filenameEl.textContent = current;
  message.classList.add('hidden');
  player.classList.remove('hidden');
  player.src = '/video?f=' + encodeURIComponent(current);
  player.play().catch(() => {});
}

async function decide(action) {
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

async function undo() {
  if (busy || btnUndo.disabled) return;
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

function updateMuteButton() {
  muteLabel.textContent = player.muted ? '🔇 Unmute' : '🔊 Mute';
}

function toggleMute() {
  player.muted = !player.muted;
  updateMuteButton();
}

updateMuteButton();

btnKeep.addEventListener('click', () => decide('keep'));
btnReject.addEventListener('click', () => decide('reject'));
btnUndo.addEventListener('click', undo);
btnMute.addEventListener('click', toggleMute);

player.addEventListener('error', () => {
  if (!current) return;
  filenameEl.textContent = current + ' (cannot play in browser — keep or reject by filename, or undo)';
});

// Reaching the end without a decision counts as Keep.
player.addEventListener('ended', () => decide('keep'));

btnBrowse.addEventListener('click', async () => {
  try {
    const res = await api('/api/browse', {});
    if (res.folder) {
      folderInput.value = res.folder;
    }
  } catch (error) {
    msgTitle.textContent = 'Error';
    msgBody.className = 'error-text';
    msgBody.textContent = error.message;
    folderForm.style.display = 'flex';
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
      if (player.paused) player.play(); else player.pause();
      break;
  }
});

// Keep-alive: ping while open so the server knows we're here; a close beacon
// tells it to shut down promptly.
setInterval(() => { fetch('/api/ping').catch(() => {}); }, 3000);
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
    showMessage('Error', error.message);
  }
})();
