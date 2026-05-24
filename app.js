/* =====================================================
   Japa Counter — Frontend Application
   Pure vanilla JS, no frameworks, no dependencies.

   HOW IT WORKS:
   1. User enters a username once; saved to localStorage.
   2. Every + or − click calls the Google Apps Script API.
   3. The leaderboard auto-refreshes every 15 seconds.
   ===================================================== */

// ── Configuration ────────────────────────────────────
// Replace this with your deployed Google Apps Script web-app URL.
// See README.md → "Step 3: Deploy the Web App" for instructions.
const API_URL = 'https://script.google.com/macros/s/AKfycbxzs9UiDuiMjNTB9i3dNboMxDrfjUo64cC9bJhmYRNzJIWVz6QQMPTTsJRl74DeCIi9/exec';

const REFRESH_INTERVAL_MS = 15 * 1000; // 15 seconds
// ─────────────────────────────────────────────────────


// ── App State ─────────────────────────────────────────
let currentUsername = '';   // lowercased, saved in localStorage
let myRounds        = 0;    // cached so we can check > 0 before decrement
let refreshTimer    = null; // holds the setInterval handle
// ─────────────────────────────────────────────────────


/* =====================================================
   BOOT — runs once when the page is ready
   ===================================================== */
document.addEventListener('DOMContentLoaded', () => {
  // Warn early if the developer forgot to set the API URL
  if (API_URL === 'YOUR_GOOGLE_APPS_SCRIPT_URL_HERE') {
    showToast('⚠ API URL not set — see app.js line 14', 'error');
  }

  wireEventListeners();

  const saved = localStorage.getItem('japaUsername');
  if (saved) {
    launchApp(saved);
  } else {
    showScreen('setup');
  }
});


/* =====================================================
   EVENT WIRING — attach all handlers once at boot
   ===================================================== */
function wireEventListeners() {
  // Setup screen
  document.getElementById('start-btn')
    .addEventListener('click', onStartClick);

  document.getElementById('username-input')
    .addEventListener('keydown', e => { if (e.key === 'Enter') onStartClick(); });

  // App screen
  document.getElementById('increment-btn')
    .addEventListener('click', onIncrement);

  document.getElementById('decrement-btn')
    .addEventListener('click', onDecrement);

  document.getElementById('change-user-btn')
    .addEventListener('click', onChangeUser);
}


/* =====================================================
   SCREEN MANAGEMENT
   ===================================================== */
function showScreen(name) {
  // 'setup' or 'app'
  const show = name === 'setup' ? 'setup-screen' : 'app-screen';
  const hide = name === 'setup' ? 'app-screen'   : 'setup-screen';

  document.getElementById(show).classList.remove('hidden');
  document.getElementById(hide).classList.add('hidden');

  if (name === 'setup') {
    document.getElementById('username-input').focus();
  }
}


/* =====================================================
   USERNAME HANDLING
   ===================================================== */
function onStartClick() {
  const input = document.getElementById('username-input');
  const raw   = input.value.trim();

  if (!raw || raw.length < 2) {
    showToast('Please enter at least 2 characters', 'error');
    input.focus();
    return;
  }

  launchApp(raw);
}

function launchApp(username) {
  currentUsername = username.toLowerCase();
  localStorage.setItem('japaUsername', currentUsername);

  // Show friendly capitalised name in the header
  document.getElementById('display-username').textContent = capitalise(username);

  showScreen('app');
  loadLeaderboard();          // immediate fetch
  startAutoRefresh();         // then every 15 s
}

function onChangeUser() {
  stopAutoRefresh();
  localStorage.removeItem('japaUsername');
  currentUsername = '';
  myRounds        = 0;

  // Reset counter display
  document.getElementById('my-rounds').textContent = '0';
  document.getElementById('counter-message').textContent = '';
  document.getElementById('username-input').value = '';

  showScreen('setup');
}


/* =====================================================
   COUNTER ACTIONS  (optimistic UI)
   The counter updates instantly on click. The API call
   runs in the background and only reverts on failure.
   ===================================================== */
async function onIncrement() {
  // Optimistic update — feels instant
  myRounds += 1;
  updateCounter(myRounds);
  showCounterMessage(encouragementFor(myRounds));

  const optimisticValue = myRounds;
  try {
    const result = await apiCall({ action: 'increment', username: currentUsername });
    // Silently sync with the server's authoritative count
    // (handles rapid clicks where optimistic value may drift)
    myRounds = result.rounds;
    updateCounter(myRounds, false);
    loadLeaderboard(); // background — don't await
  } catch {
    // Revert to what it was before this click
    myRounds = optimisticValue - 1;
    updateCounter(myRounds, false);
    showToast('Could not save — check your connection', 'error');
  }
}

async function onDecrement() {
  if (myRounds <= 0) {
    showToast('Already at zero rounds!');
    return;
  }

  // Optimistic update
  myRounds -= 1;
  updateCounter(myRounds, false);

  const optimisticValue = myRounds;
  try {
    const result = await apiCall({ action: 'decrement', username: currentUsername });
    myRounds = result.rounds;
    updateCounter(myRounds, false);
  } catch {
    // Revert
    myRounds = optimisticValue + 1;
    updateCounter(myRounds, false);
    showToast('Could not save — check your connection', 'error');
  }
}


/* =====================================================
   LEADERBOARD
   ===================================================== */
async function loadLeaderboard() {
  setRefreshStatus('Refreshing…', true);
  try {
    const data = await apiGet('leaderboard');
    renderLeaderboard(data);

    // Keep myRounds in sync with server value
    const mine = (data.leaderboard || []).find(e => e.username === currentUsername);
    if (mine) {
      myRounds = mine.rounds;
      updateCounter(myRounds, false); // silent sync — no animation
    }

    setRefreshStatus('Updated ✓', true);
    setTimeout(() => setRefreshStatus('', false), 2200);
  } catch {
    setRefreshStatus('Refresh failed', true);
    document.getElementById('leaderboard-list').innerHTML =
      '<div class="error-state">Could not load leaderboard.<br>Check your internet connection.</div>';
  }
}

function renderLeaderboard(data) {
  // Community totals
  document.getElementById('total-rounds').textContent   = (data.total   ?? 0).toString();
  document.getElementById('total-devotees').textContent = (data.leaderboard?.length ?? 0).toString();

  const list = document.getElementById('leaderboard-list');

  if (!data.leaderboard || data.leaderboard.length === 0) {
    list.innerHTML = '<div class="empty-state">No rounds logged today yet.<br>Be the first! 🌸</div>';
    return;
  }

  list.innerHTML = data.leaderboard.map((entry, i) => {
    const rank = i + 1;
    const isMe = entry.username === currentUsername;
    return `
      <div class="leaderboard-item${isMe ? ' is-me' : ''}">
        <span class="rank rank-${rank <= 3 ? rank : 'other'}">${rankIcon(rank)}</span>
        <span class="lb-name">
          ${escapeHtml(capitalise(entry.username))}
          ${isMe ? '<span class="you-tag">you</span>' : ''}
        </span>
        <span class="lb-rounds">${entry.rounds}</span>
      </div>
    `;
  }).join('');
}

/* =====================================================
   AUTO-REFRESH
   ===================================================== */
function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(loadLeaderboard, REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}


/* =====================================================
   API LAYER
   ===================================================== */

// GET  → ?action=leaderboard
async function apiGet(action) {
  const url = `${API_URL}?action=${encodeURIComponent(action)}`;
  const res = await fetch(url, { method: 'GET', redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// POST → body: { action, username }
// Apps Script web apps accept JSON POST with redirect: 'follow'.
async function apiCall(body) {
  const res = await fetch(API_URL, {
    method:   'POST',
    redirect: 'follow',
    headers:  { 'Content-Type': 'text/plain' }, // text/plain avoids preflight CORS for simple requests
    body:     JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}


/* =====================================================
   UI HELPERS
   ===================================================== */

function updateCounter(rounds, animate = true) {
  const el = document.getElementById('my-rounds');
  el.textContent = rounds;

  if (animate) {
    el.classList.remove('bump');
    void el.offsetWidth; // force reflow so animation restarts
    el.classList.add('bump');
  }

  // Disable the minus button when already at 0
  document.getElementById('decrement-btn').disabled = rounds <= 0;
}


function setRefreshStatus(text, visible) {
  const el = document.getElementById('refresh-status');
  el.textContent = text;
  el.classList.toggle('visible', visible);
}

function showCounterMessage(text) {
  document.getElementById('counter-message').textContent = text;
}

// ── Toast ─────────────────────────────────────────────
let _toastTimer = null;

function showToast(message, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  clearTimeout(_toastTimer);

  const el = document.createElement('div');
  el.className = `toast${type === 'error' ? ' toast-error' : ''}`;
  el.textContent = message;
  document.body.appendChild(el);

  requestAnimationFrame(() => el.classList.add('show'));

  _toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 350);
  }, 3000);
}


/* =====================================================
   PURE HELPERS (no side-effects)
   ===================================================== */

// Returns an encouraging message based on round milestones.
// One mala = 108 beads, but many traditions count in malas of 1 round.
// Here we treat every 4 rounds as "one mala" for display purposes —
// adjust the thresholds to match your community's convention.
function encouragementFor(rounds) {
  if (rounds === 1)              return 'First round! Great start 🌸';
  if (rounds === 4)              return '1 mala complete! 🙏';
  if (rounds === 8)              return '2 malas! Wonderful 🕉';
  if (rounds === 16)             return '4 malas! Dedicated 🌟';
  if (rounds === 32)             return '8 malas! Incredible devotion 🌺';
  if (rounds > 0 && rounds % 4 === 0) return `${rounds / 4} malas! 🙏`;
  return '';
}

function rankIcon(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

// Capitalise the first letter only (keeps rest of string as-is)
function capitalise(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Prevent XSS when injecting user-supplied names into innerHTML
function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}
